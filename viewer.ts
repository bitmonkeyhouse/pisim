// Shows a simulator in the current terminal pane via the Kitty graphics protocol, and drives it:
// clicks tap, drags swipe, typing types. Frames come from simhelper video only when the display changes;
// the device bezel is a second image drawn on top. ctrl-y then h/l/s/+/- presses Home, Lock, Siri or
// volume up/down, r or the arrows rotate the device, z zooms to fill the pane, b toggles lean mode, and on a foldable
// o/c/p open, close or half-fold it and f toggles open and closed; q or Ctrl-C quits. The herdr pane widens
// when a turned or opened device needs it (fitPane).
// Usage: node viewer.ts <udid> [label]
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { promisify } from "node:util";
import { type Bezel, fits, loadBezel, renderBezel, screenPitch, stretchBezel, turnBezel } from "./bezel.ts";
import { type Button, buttonLines, helper, keyLines, keymap, screenshot, startHid } from "./sim.ts";

const run = promisify(execFile);

const [udid, label = udid] = process.argv.slice(2);
if (!udid) {
	console.error("usage: node viewer.ts <udid> [label]");
	process.exit(2);
}

type Box = { col: number; row: number; c: number; r: number }; // 0-based cell position and size in cells
// `need` is the pane width in cells that fits the device at physical size, if that's known.
type Layout = { w: number; h: number; screen: Box; bezel?: Box & { png: Buffer }; need?: number };

const ESC = "\x1b";
const out = process.stdout;
let cell = { w: 8, h: 16 }; // fallbacks if the terminal doesn't answer
let background = "000000";
let bezel: Bezel | null | undefined; // null when the device has no usable bezel
let video: ChildProcess | undefined;
let source: { w: number; h: number } | undefined; // the display's size in pixels, from simhelper video
let layout: Layout | undefined; // recomputed on resize and when the device or the display's size changes
// How far the device is turned clockwise, in quarter turns. The display buffer stays portrait, so the
// picture is turned to match and clicks are turned back.
let quarter = 0;
// Quarter turns the streamed display's own picture needs to be upright (a foldable's inner display),
// from simhelper video; the picture is drawn turned by both.
let baseTurn = 0;
const turn = () => (baseTurn + quarter) % 4;
let foldable = false; // simhelper video found two main displays (an iPhone Duo)
let open = false; // a foldable is showing its inner display
let zoom = false; // fill the pane instead of physical size
// Lean mode, for herdr clients watching over SSH: herdr sends them every frame as raw pixels, which
// can swamp the connection and slow the whole window. Frames go at half resolution (the terminal
// scales them up) and at most 10 a second. On while a remote client is connected to this machine's
// herdr, unless toggled by hand.
let lean = false;
let leanByHand = false;
const LEAN_FRAME_MS = 100;
let lastFrameAt = 0;
async function detectLean() {
	if (leanByHand) return;
	// Each remote client has a `herdr remote-client-bridge` here; the program name must be herdr too,
	// as the ssh command of a client on this machine connecting out to another has that text in it.
	const { stdout } = await run("ps", ["-A", "-o", "ucomm=,args="]);
	const remote = /^herdr\s+(\S*\/)?herdr remote-client-bridge\b/m.test(stdout);
	if (remote !== lean) {
		lean = remote;
		relayout();
	}
}
// simhelper hid's orientation for each: portrait, landscape with its top on the right, upside down,
// landscape with its top on the left.
const ORIENTATIONS = [1, 4, 2, 3];

function quit() {
	video?.stdin!.end(); // simhelper video removes its frame directory when its input closes
	hid?.kill();
	if (bezel) rmSync(bezel.dir, { recursive: true, force: true });
	out.write(`${ESC}[?1016l${ESC}[?1006l${ESC}[?1002l${ESC}[?1000l${ESC}_Ga=d,d=A,q=2${ESC}\\${ESC}[?25h${ESC}[2J${ESC}[H`);
	process.exit(0);
}

// Ask the terminal for its cell size in pixels (reply ESC [ 6 ; h ; w t) and its background colour
// (reply ESC ] 11 ; rgb:RRRR/GGGG/BBBB).
function queryTerminal(): Promise<void> {
	return new Promise((resolve) => {
		let reply = "";
		const done = () => {
			process.stdin.off("data", onData);
			resolve();
		};
		const onData = (d: Buffer) => {
			reply += d.toString();
			const size = /\x1b\[6;(\d+);(\d+)t/.exec(reply);
			const bg = /\x1b\]11;rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i.exec(reply);
			if (size) cell = { h: Number(size[1]), w: Number(size[2]) };
			if (bg) background = bg.slice(1).map((c) => (c + c).slice(0, 2)).join("");
			if (size && bg) done();
		};
		process.stdin.on("data", onData);
		setTimeout(done, 300);
		out.write(`${ESC}]11;?${ESC}\\${ESC}[16t`);
	});
}

const centre = (n: number, k: number) => Math.max(0, Math.floor((n - k) / 2));

// Physical size, as Simulator.app's: the device as big as the real one, in terminal (device) pixels
// per framebuffer pixel, from the pixels per inch of the display the terminal is on (simhelper video
// reports it, and again when the window moves to another display) and the device's. Infinity if
// either is unknown, so the device just fits the pane.
// shortcut: assumes the terminal's cell size in pixels stays the same; moving between displays with
// different scales (Retina and non-Retina) needs the viewer reopened.
let ppi = 0;
let gotPpi: () => void;
const firstPpi = new Promise<void>((resolve) => (gotPpi = resolve));
const pitch = screenPitch(udid).catch(() => 0);
async function naturalScale(): Promise<number> {
	await firstPpi;
	const p = await pitch;
	return ppi > 0 && p > 0 ? ppi / p : Infinity;
}

// The apps (terminal windows) showing this pane: the nearest .app ancestor of each herdr client, and
// of this process, for a viewer run outside herdr. herdr runs panes under its server, not the client.
async function terminalPids(): Promise<string[]> {
	const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid=,comm="]);
	const procs = new Map(stdout.trim().split("\n").map((l) => {
		const [, pid, ppid, comm] = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)!;
		return [pid, { ppid, comm }];
	}));
	const starts = [String(process.pid), ...[...procs].filter(([, p]) => /(^|\/)herdr$/.test(p.comm)).map(([pid]) => pid)];
	const apps = new Set<string>();
	for (const start of starts) {
		for (let q = procs.get(start)?.ppid; q && q !== "1" && procs.has(q); q = procs.get(q)!.ppid) {
			if (procs.get(q)!.comm.includes(".app/")) {
				apps.add(q);
				break;
			}
		}
	}
	return [...apps];
}

// Lays the device out in the pane at physical size, or (zoomed) as big as fits, less a margin of 2
// cols each side and 1 row top and bottom; a pane too small for that shrinks it to fit.
// The screen gets a whole-cell box and the bezel is scaled and padded around it so the two line up
// exactly: Kitty images can only be stretched to whole cells.
async function layoutFor(w: number, h: number): Promise<Layout> {
	const cols = out.columns;
	const rows = out.rows;
	bezel ??= await loadBezel(udid, Math.min(w, h)).catch(() => null);
	// w x h is the screen as shown, turned; the bezel is built portrait, around the unturned buffer.
	const odd = turn() % 2 === 1;
	const frame = bezel && (fits(bezel, odd ? h : w, odd ? w : h) ? bezel : stretchBezel(bezel, odd ? h : w, odd ? w : h));
	const b = frame && turnBezel(frame, turn());
	const dev = b ?? { w, h, x: 0, y: 0, hw: w, hh: h };
	const fit = Math.min((Math.max(1, cols - 4) * cell.w) / dev.w, (Math.max(1, rows - 2) * cell.h) / dev.h);
	const natural = await naturalScale();
	const s = zoom ? fit : Math.min(fit, natural);
	const need = natural < Infinity ? Math.ceil((dev.w * natural) / cell.w) + 5 : undefined; // margin, and a cell for padLeft
	const c = Math.max(1, Math.round((dev.hw * s) / cell.w));
	const r = Math.max(1, Math.round((dev.hh * s) / cell.h));
	const bare = { w, h, screen: { col: centre(cols, c), row: centre(rows, r), c, r }, need };
	if (!b) return bare;

	const sx = (c * cell.w) / b.hw;
	const sy = (r * cell.h) / b.hh;
	const holeX = Math.round(b.x * sx);
	const holeY = Math.round(b.y * sy);
	const padLeft = (cell.w - (holeX % cell.w)) % cell.w; // puts the hole on a cell boundary
	const padTop = (cell.h - (holeY % cell.h)) % cell.h;
	const bw = Math.round(b.w * sx);
	const bh = Math.round(b.h * sy);
	const bc = Math.ceil((padLeft + bw) / cell.w);
	const br = Math.ceil((padTop + bh) / cell.h);
	const png = await renderBezel(b, await screenshot(udid), {
		w: bw,
		h: bh,
		canvasW: bc * cell.w,
		canvasH: br * cell.h,
		padLeft,
		padTop,
		holeX: padLeft + holeX,
		holeY: padTop + holeY,
		holeW: c * cell.w,
		holeH: r * cell.h,
		background,
	}).catch(() => null);
	if (!png) return bare;
	const col = centre(cols, bc);
	const row = centre(rows, br);
	return {
		w,
		h,
		screen: { col: col + (padLeft + holeX) / cell.w, row: row + (padTop + holeY) / cell.h, c, r },
		bezel: { col, row, c: bc, r: br, png },
		need,
	};
}

// When the device turns or folds, the herdr pane is widened if the device no longer fits at physical
// size, and put back to its old width once it fits again, unless it was resized by hand in between.
let shape: string | undefined; // the shown screen's size when the pane was last fitted
let restoreCols: number | undefined; // the pane's width before it was widened
let setCols: number | undefined; // the width it was widened to
async function fitPane(need: number) {
	const pane = process.env.HERDR_PANE_ID;
	if (!pane) return;
	const cols = out.columns;
	const base = restoreCols !== undefined && cols === setCols ? restoreCols : cols;
	const target = Math.max(need, base);
	restoreCols = target > base ? base : undefined;
	setCols = cols; // until the resize says otherwise
	if (target === cols) return;
	type Rect = { x: number; width: number };
	const { layout: l } = JSON.parse((await run("herdr", ["pane", "layout", "--pane", pane])).stdout).result;
	const me: Rect = l.panes.find((p: { pane_id: string }) => p.pane_id === pane).rect;
	// The innermost side-by-side split holding the pane; resizing moves its divider.
	const split: Rect | undefined = l.splits
		.filter((t: { direction: string; rect: Rect }) => t.direction === "right" && t.rect.x <= me.x && me.x + me.width <= t.rect.x + t.rect.width)
		.map((t: { rect: Rect }) => t.rect)
		.sort((a: Rect, b: Rect) => a.width - b.width)[0];
	if (!split) return;
	const delta = Math.min(target - cols, split.width - me.width - 40); // leaves the panes beside it 40 columns
	if (delta === 0) return;
	const growsLeft = me.x > split.x; // the divider is on the pane's left
	const direction = delta > 0 === growsLeft ? "left" : "right";
	const { stdout } = await run("herdr", ["pane", "resize", "--pane", pane, "--direction", direction, "--amount", String(Math.abs(delta) / split.width)]);
	const after = JSON.parse(stdout).result.resize.layout.panes.find((p: { pane_id: string }) => p.pane_id === pane);
	if (after) setCols = cols + after.rect.width - me.width; // herdr's widths include the pane's border
}

// The bezel is image 2, on top. The screen rotates through images 1, 3 and 4, each new frame on a
// higher layer: herdr shows a newly uploaded image a few redraws late, so replacing the visible
// image (or deleting it) leaves the screen blank in between. Reusing the oldest id only replaces a
// frame already buried under the two newer ones.
const SCREEN_IDS = [1, 3, 4];
const BEZEL_Z = 2 ** 30;
let frameNo = 0;

function place(id: number, z: number, box: Box, png: Buffer) {
	const data = png.toString("base64");
	let s = `${ESC}[${box.row + 1};${box.col + 1}H`;
	for (let i = 0; i < data.length; i += 4096) {
		const more = i + 4096 < data.length ? 1 : 0;
		const head = i === 0 ? `a=T,f=100,i=${id},p=1,c=${box.c},r=${box.r},z=${z},C=1,q=2,m=${more}` : `m=${more}`;
		s += `${ESC}_G${head};${data.slice(i, i + 4096)}${ESC}\\`;
	}
	out.write(s);
}

// A w x h RGB frame file from simhelper video, which the terminal reads and deletes (t=t).
function placeScreen(box: Box, w: number, h: number, path: string, written: () => void) {
	frameNo++;
	const head = `a=T,f=24,s=${w},v=${h},t=t,i=${SCREEN_IDS[frameNo % SCREEN_IDS.length]},p=1,c=${box.c},r=${box.r},z=${frameNo},C=1,q=2`;
	out.write(`${ESC}[${box.row + 1};${box.col + 1}H${ESC}_G${head};${Buffer.from(path).toString("base64")}${ESC}\\`, written);
}

function fail(msg: string) {
	layout = undefined;
	out.write(`${ESC}_Ga=d,d=A,q=2${ESC}\\${ESC}[2J${ESC}[H${label}: ${msg}\r\n(retrying)`);
}

// Lays the device out for the display's size, turned to the device's orientation, and asks simhelper
// video for frames turned the same way that fill the screen box.
let laying = false;
let again = false; // a resize or rotation arrived while laying out
async function relayout() {
	if (!source) return;
	if (laying) return void (again = true);
	laying = true;
	again = false;
	try {
		const odd = turn() % 2 === 1;
		const l = await layoutFor(odd ? source.h : source.w, odd ? source.w : source.h);
		layout = l;
		const shown = `${l.w}x${l.h}`;
		if (shown !== shape) {
			if (shape && !zoom && l.need) fitPane(l.need).catch(() => {}); // the pane's resize lays out again
			shape = shown;
		}
		out.write(`${ESC}_Ga=d,d=A,q=2${ESC}\\${ESC}[2J`);
		if (l.bezel) place(2, BEZEL_Z, l.bezel, l.bezel.png);
		const res = lean ? 0.5 : 1;
		video?.stdin!.write(`rotate ${turn()}\nsize ${Math.round(l.screen.c * cell.w * res)} ${Math.round(l.screen.r * cell.h * res)}\n`);
	} catch (e) {
		fail((e as Error).message);
	} finally {
		laying = false;
		if (again) relayout();
	}
}

// simhelper video sends "source <w> <h>" when it learns the display's size and "frame <w> <h> <path>" per
// frame; it waits for "next" before producing another.
function stream() {
	Promise.all([helper(), terminalPids().catch(() => [])]).then(
		([bin, pids]) => {
			let buf = "";
			let err = "";
			video = spawn(bin, ["video", udid, ...pids], { stdio: ["pipe", "pipe", "pipe"] });
			video.stdin!.on("error", () => {}); // a dead helper is reported by "close"
			video.stdout!.on("data", (d) => {
				buf += d;
				for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) {
					const line = buf.slice(0, i);
					const src = /^source (\d+) (\d+)(?: (\d))?$/.exec(line);
					const frame = /^frame (\d+) (\d+) (.+)$/.exec(line);
					const density = /^ppi ([\d.]+)$/.exec(line);
					if (density) {
						ppi = Number(density[1]);
						gotPpi();
						if (!zoom) relayout(); // the terminal moved to another display
					} else if (line === "foldable") {
						foldable = true;
					} else if (src) {
						source = { w: Number(src[1]), h: Number(src[2]) };
						baseTurn = Number(src[3] ?? 0);
						open = foldable && baseTurn !== 0;
						relayout();
					} else if (frame && layout) {
						placeScreen(layout.screen, Number(frame[1]), Number(frame[2]), frame[3], () => {
							const wait = lean ? lastFrameAt + LEAN_FRAME_MS - Date.now() : 0;
							lastFrameAt = Date.now() + Math.max(0, wait);
							setTimeout(() => video?.stdin!.write("next\n"), Math.max(0, wait));
						});
					} else if (frame) {
						rmSync(frame[3], { force: true }); // no layout yet to draw it in
						video.stdin!.write("next\n");
					}
				}
			});
			video.stderr!.on("data", (d) => (err += d));
			video.on("close", () => {
				fail(err.trim().split("\n").pop() || "simhelper video stopped");
				setTimeout(stream, 1000);
			});
		},
		(e) => {
			fail(`couldn't build simhelper: ${(e as Error).message.split("\n")[0]}`);
			setTimeout(stream, 1000);
		},
	);
}

// Input goes through simhelper hid (see sim.ts), restarted a second after it stops.
let hid: ChildProcess | undefined;
let hidReady = false;
let statusShown = false;

// Shows a message on the top row, wrapped at a space onto the second if the pane is too narrow.
function status(msg = "") {
	if (!msg && !statusShown) return;
	const cut = msg.length > out.columns ? msg.lastIndexOf(" ", out.columns) : -1;
	const [first, second] = cut > 0 ? [msg.slice(0, cut), msg.slice(cut + 1)] : [msg, ""];
	out.write(`${ESC}[1;1H${ESC}[2K${first.slice(0, out.columns)}${ESC}[2;1H${ESC}[2K${second.slice(0, out.columns)}`);
	statusShown = !!msg;
}

async function connectHid() {
	try {
		hid = await startHid(udid);
	} catch (e) {
		status((e as Error).message.split("\n")[0]);
		return setTimeout(connectHid, 1000);
	}
	hidReady = true;
	status();
	send(`orientation ${ORIENTATIONS[quarter]}`); // the viewer starts portrait, so put the device there too
	let err = "";
	hid.stderr!.on("data", (d) => (err += d));
	hid.on("close", () => {
		hidReady = false;
		status(err.trim().split("\n").pop() || "simhelper hid stopped");
		setTimeout(connectHid, 1000);
	});
}

const send = (line: string) => hidReady && hid!.stdin!.write(`${line}\n`);

// Mouse position (1-based pane pixels from SGR pixel mode) as a fraction of the screen, if it's on it.
function onScreen(x: number, y: number, clamp = false) {
	const s = layout?.screen;
	if (!s) return;
	let fx = (x - 1 - s.col * cell.w) / (s.c * cell.w);
	let fy = (y - 1 - s.row * cell.h) / (s.r * cell.h);
	if (clamp) [fx, fy] = [Math.min(1, Math.max(0, fx)), Math.min(1, Math.max(0, fy))];
	return fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1 ? { fx, fy } : undefined;
}

// The mouse is passed through live: press starts a touch, dragging moves it, release ends it, so taps,
// drags, flicks and long-presses all behave as they would with a finger. A press off the screen is ignored.
let touching = false;
function onMouse(button: number, x: number, y: number, released: boolean) {
	const p = onScreen(x, y, touching);
	if (!p) return;
	// Touches are in the display buffer's portrait coordinates: undo the turn the picture is drawn with.
	const [bx, by] = [[p.fx, p.fy], [p.fy, 1 - p.fx], [1 - p.fx, 1 - p.fy], [1 - p.fy, p.fx]][turn()];
	const at = `${bx.toFixed(4)} ${by.toFixed(4)}`;
	if (released) {
		if (touching) send(`up ${at}`);
		touching = false;
	} else if (button === 0) {
		send(`down ${at}`);
		touching = true;
	} else if (button === 32 && touching) send(`move ${at}`);
}

let keys = new Map<string, number[]>();
keymap(udid).then((k) => (keys = k));
const press = (k: number[]) => keyLines(k).forEach(send);

// ctrl-y then a key presses a hardware button, rotates, zooms or (on a foldable) folds the device;
// any other key cancels.
const BUTTON_KEYS: Record<string, Button> = { h: "home", l: "lock", s: "siri", "+": "volume-up", "-": "volume-down" };
const ROTATE_KEYS: Record<string, number> = { r: 1, "\x1b[C": 1, "\x1b[D": -1 }; // r and → clockwise, ← anticlockwise
// Hinge angles: open, closed, partial (Device Hub's Book).
const FOLD_KEYS: Record<string, number> = { o: 180, c: 0, p: 130 };
let buttonPrefix = false;

function rotate(by: number) {
	quarter = (quarter + by + 4) % 4;
	send(`orientation ${ORIENTATIONS[quarter]}`);
	relayout();
}

function onInput(d: Buffer) {
	for (const [tok, b, x, y, kind] of d.toString().matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[[ABCD]|[\s\S]/g)) {
		if (kind) onMouse(Number(b), Number(x), Number(y), kind === "m");
		else if (tok === "\x03") quit();
		else if (buttonPrefix) {
			buttonPrefix = false;
			status();
			const key = tok.length > 1 ? tok : tok.toLowerCase();
			if (BUTTON_KEYS[key]) buttonLines(BUTTON_KEYS[key]).forEach(send);
			else if (ROTATE_KEYS[key]) rotate(ROTATE_KEYS[key]);
			else if (key === "z") {
				zoom = !zoom;
				relayout();
			} else if (key === "q") quit();
			else if (key === "b") {
				lean = !lean;
				leanByHand = true;
				relayout();
			}
			else if (foldable && key in FOLD_KEYS) send(`hinge ${FOLD_KEYS[key]}`);
			else if (foldable && key === "f") send(`hinge ${open ? 0 : 180}`);
		} else if (tok === "\x19") {
			buttonPrefix = true;
			status(`h home l lock s siri +/- vol r turn z zoom b lean${foldable ? " o/c/p/f fold" : ""} q quit`);
		} else if (keys.has(tok)) press(keys.get(tok)!);
	}
}

process.stdin.setRawMode(true);
process.stdin.resume();
await queryTerminal();
process.stdin.on("data", onInput);
out.on("resize", relayout);
process.on("SIGTERM", quit);
process.on("SIGHUP", quit);
// Mouse reporting: 1000 press/release, 1002 drags, 1006 SGR encoding, 1016 positions in pixels.
out.write(`${ESC}[?25l${ESC}[2J${ESC}[?1000h${ESC}[?1002h${ESC}[?1006h${ESC}[?1016h`);
stream();
detectLean().catch(() => {});
setInterval(() => detectLean().catch(() => {}), 3000);
connectHid();
