// Shows a simulator in the current terminal pane via the Kitty graphics protocol, and drives it:
// clicks tap, drags swipe, typing types. Frames come from simvideo only when the display changes;
// the device bezel is a second image drawn on top. Ctrl-C quits.
// Usage: node viewer.ts <udid> [label]
import { type ChildProcess, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { type Bezel, fits, loadBezel, renderBezel } from "./bezel.ts";
import { helper, keyLines, keymap, screenshot, startHid } from "./sim.ts";

const [udid, label = udid] = process.argv.slice(2);
if (!udid) {
	console.error("usage: node viewer.ts <udid> [label]");
	process.exit(2);
}

type Box = { col: number; row: number; c: number; r: number }; // 0-based cell position and size in cells
type Layout = { w: number; h: number; screen: Box; bezel?: Box & { png: Buffer } };

const ESC = "\x1b";
const out = process.stdout;
let cell = { w: 8, h: 16 }; // fallbacks if the terminal doesn't answer
let background = "000000";
let bezel: Bezel | null | undefined; // null when the device has no usable bezel
let video: ChildProcess | undefined;
let source: { w: number; h: number } | undefined; // the display's size in pixels, from simvideo
let layout: Layout | undefined; // recomputed on resize and when the display's size changes (rotation)

function quit() {
	video?.stdin!.end(); // simvideo removes its frame directory when its input closes
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

// Fits the device into the pane, less a margin of 2 cols each side and 1 row top and bottom.
// The screen gets a whole-cell box and the bezel is scaled and padded around it so the two line up
// exactly: Kitty images can only be stretched to whole cells.
async function layoutFor(w: number, h: number): Promise<Layout> {
	const cols = out.columns;
	const rows = out.rows;
	bezel ??= await loadBezel(udid, Math.min(w, h)).catch(() => null);
	const b = bezel && fits(bezel, w, h) ? bezel : null;
	const dev = b ?? { w, h, x: 0, y: 0, hw: w, hh: h };
	const s = Math.min((Math.max(1, cols - 4) * cell.w) / dev.w, (Math.max(1, rows - 2) * cell.h) / dev.h);
	const c = Math.max(1, Math.round((dev.hw * s) / cell.w));
	const r = Math.max(1, Math.round((dev.hh * s) / cell.h));
	const bare = { w, h, screen: { col: centre(cols, c), row: centre(rows, r), c, r } };
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
	};
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

// A w x h RGBA frame file from simvideo, which the terminal reads and deletes (t=t).
function placeScreen(box: Box, w: number, h: number, path: string, written: () => void) {
	frameNo++;
	const head = `a=T,f=32,s=${w},v=${h},t=t,i=${SCREEN_IDS[frameNo % SCREEN_IDS.length]},p=1,c=${box.c},r=${box.r},z=${frameNo},C=1,q=2`;
	out.write(`${ESC}[${box.row + 1};${box.col + 1}H${ESC}_G${head};${Buffer.from(path).toString("base64")}${ESC}\\`, written);
}

function fail(msg: string) {
	layout = undefined;
	out.write(`${ESC}_Ga=d,d=A,q=2${ESC}\\${ESC}[2J${ESC}[H${label}: ${msg}\r\n(retrying)`);
}

// Lays the device out for the display's size and asks simvideo for frames that fill the screen box.
let laying = false;
let again = false; // a resize or rotation arrived while laying out
async function relayout() {
	if (!source) return;
	if (laying) return void (again = true);
	laying = true;
	again = false;
	try {
		const l = await layoutFor(source.w, source.h);
		layout = l;
		out.write(`${ESC}_Ga=d,d=A,q=2${ESC}\\${ESC}[2J`);
		if (l.bezel) place(2, BEZEL_Z, l.bezel, l.bezel.png);
		video?.stdin!.write(`size ${l.screen.c * cell.w} ${l.screen.r * cell.h}\n`);
	} catch (e) {
		fail((e as Error).message);
	} finally {
		laying = false;
		if (again) relayout();
	}
}

// simvideo sends "source <w> <h>" when it learns the display's size and "frame <w> <h> <path>" per
// frame; it waits for "next" before producing another.
function stream() {
	helper("simvideo").then(
		(bin) => {
			let buf = "";
			let err = "";
			video = spawn(bin, [udid], { stdio: ["pipe", "pipe", "pipe"] });
			video.stdin!.on("error", () => {}); // a dead helper is reported by "close"
			video.stdout!.on("data", (d) => {
				buf += d;
				for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) {
					const line = buf.slice(0, i);
					const src = /^source (\d+) (\d+)$/.exec(line);
					const frame = /^frame (\d+) (\d+) (.+)$/.exec(line);
					if (src) {
						source = { w: Number(src[1]), h: Number(src[2]) };
						relayout();
					} else if (frame && layout) {
						placeScreen(layout.screen, Number(frame[1]), Number(frame[2]), frame[3], () => video?.stdin!.write("next\n"));
					} else if (frame) {
						rmSync(frame[3], { force: true }); // no layout yet to draw it in
						video.stdin!.write("next\n");
					}
				}
			});
			video.stderr!.on("data", (d) => (err += d));
			video.on("close", () => {
				fail(err.trim().split("\n").pop() || "simvideo stopped");
				setTimeout(stream, 1000);
			});
		},
		(e) => {
			fail(`couldn't build simvideo: ${(e as Error).message.split("\n")[0]}`);
			setTimeout(stream, 1000);
		},
	);
}

// Input goes through simhid (see sim.ts), restarted a second after it stops.
let hid: ChildProcess | undefined;
let hidReady = false;
let statusShown = false;

function status(msg?: string) {
	if (msg || statusShown) out.write(`${ESC}[1;1H${ESC}[2K${msg ?? ""}`);
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
	let err = "";
	hid.stderr!.on("data", (d) => (err += d));
	hid.on("close", () => {
		hidReady = false;
		status(err.trim().split("\n").pop() || "simhid stopped");
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
	const at = `${p.fx.toFixed(4)} ${p.fy.toFixed(4)}`;
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

function onInput(d: Buffer) {
	for (const [tok, b, x, y, kind] of d.toString().matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[[ABCD]|[\s\S]/g)) {
		if (kind) onMouse(Number(b), Number(x), Number(y), kind === "m");
		else if (tok === "\x03") quit();
		else if (keys.has(tok)) press(keys.get(tok)!);
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
connectHid();
