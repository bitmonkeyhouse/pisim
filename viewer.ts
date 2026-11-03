// Shows a simulator in the current terminal pane via the Kitty graphics protocol, and drives it:
// clicks tap, drags swipe, typing types. Frames stream from `axe stream-video` (~18 fps); the
// device bezel is a second image drawn on top. Ctrl-C quits.
// Usage: node viewer.ts <udid> [label]
import { type ChildProcess, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { type Bezel, fits, loadBezel, renderBezel } from "./bezel.ts";
import { axe as runAxe, screenshot } from "./sim.ts";

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
let background = "black";
let bezel: Bezel | null | undefined; // null when the device has no usable bezel
let axe: ChildProcess | undefined;
let frame: Buffer | undefined; // latest PNG from axe
let shown: Buffer | undefined; // last frame drawn (or skipped as identical)
let layout: Layout | undefined; // dropped on resize, recomputed when the frame size changes (rotation)
let busy = false;

function quit() {
	axe?.kill();
	if (bezel) rmSync(bezel.dir, { recursive: true, force: true });
	out.write(`${ESC}[?1016l${ESC}[?1006l${ESC}[?1000l${ESC}_Ga=d,d=A,q=2${ESC}\\${ESC}[?25h${ESC}[2J${ESC}[H`);
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
			if (bg) background = `0x${bg.slice(1).map((c) => (c + c).slice(0, 2)).join("")}`;
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

function placeScreen(box: Box, png: Buffer) {
	frameNo++;
	place(SCREEN_IDS[frameNo % SCREEN_IDS.length], frameNo, box, png);
}

function fail(msg: string) {
	layout = undefined;
	shown = undefined;
	out.write(`${ESC}_Ga=d,d=A,q=2${ESC}\\${ESC}[2J${ESC}[H${label}: ${msg}\r\n(retrying)`);
}

// Draws the latest frame unless it's unchanged or the terminal is still catching up; skipped frames are just dropped.
async function update() {
	const f = frame;
	if (busy || !f || f === shown || out.writableNeedDrain) return;
	busy = true;
	try {
		if (f.readUInt32BE(0) !== 0x89504e47) throw new Error("axe sent a frame that isn't a PNG");
		const w = f.readUInt32BE(16);
		const h = f.readUInt32BE(20);
		if (layout?.w !== w || layout?.h !== h) {
			layout = await layoutFor(w, h);
			shown = undefined;
			out.write(`${ESC}_Ga=d,d=A,q=2${ESC}\\${ESC}[2J`);
			if (layout.bezel) place(2, BEZEL_Z, layout.bezel, layout.bezel.png);
		}
		if (!shown?.equals(f)) placeScreen(layout.screen, f);
		shown = f;
	} catch (e) {
		fail((e as Error).message);
	} finally {
		busy = false;
		if (frame !== f) update();
	}
}

// axe's raw format is a stream of PNGs, each prefixed with its length as a big-endian u32.
function stream() {
	let buf = Buffer.alloc(0);
	let err = "";
	axe = spawn("axe", ["stream-video", "--udid", udid, "--format", "raw", "--fps", "30"], { stdio: ["ignore", "pipe", "pipe"] });
	axe.stdout!.on("data", (d: Buffer) => {
		buf = Buffer.concat([buf, d]);
		while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
			frame = buf.subarray(4, 4 + buf.readUInt32BE(0));
			buf = buf.subarray(4 + frame.length);
		}
		update();
	});
	axe.stderr!.on("data", (d) => (err += d));
	axe.on("error", (e: NodeJS.ErrnoException) => {
		err = e.code === "ENOENT" ? "AXe is not installed: brew install cameroncooke/axe/axe" : e.message;
	});
	axe.on("close", () => {
		fail(err.trim().split("\n").pop() || "axe stream-video stopped");
		setTimeout(stream, 1000);
	});
}

// Device screen size in points (what axe taps in), from the accessibility tree's root frame.
let points: { key: string; w: number; h: number } | undefined;
async function screenPoints() {
	const key = `${layout?.w}x${layout?.h}`;
	if (points?.key !== key) {
		const [root] = JSON.parse(await runAxe("describe-ui", "--udid", udid));
		points = { key, w: root.frame.width, h: root.frame.height };
	}
	return points;
}

// Input becomes `axe batch` steps, run in order. A batch shares one simulator HID session: separate
// axe commands each pay AXe's ~0.5s Xcode 27 wait, and a key sent right after another command can
// be dropped. Typing collects until it pauses; a click or drag sends everything at once.
type Step = (pts: { w: number; h: number }) => string;
let steps: Step[] = [];
let typed = "";
let typingTimer: NodeJS.Timeout | undefined;
let running = false;
let errorShown = false;

function takeTyped() {
	clearTimeout(typingTimer);
	const t = typed;
	if (t) steps.push(() => `type "${t.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`);
	typed = "";
}

async function run() {
	if (running || !steps.length) return;
	running = true;
	const batch = steps;
	steps = [];
	try {
		const pts = await screenPoints();
		await runAxe("batch", "--udid", udid, ...batch.flatMap((s) => ["--step", s(pts)]));
		if (errorShown) out.write(`${ESC}[1;1H${ESC}[2K`);
		errorShown = false;
	} catch (e) {
		out.write(`${ESC}[1;1H${ESC}[2K${(e as Error).message.split("\n")[0]}`);
		errorShown = true;
	} finally {
		running = false;
		run();
	}
}

const flush = () => {
	takeTyped();
	run();
};

// Mouse position (1-based pane pixels from SGR pixel mode) as a fraction of the screen, if it's on it.
function onScreen(x: number, y: number, clamp = false) {
	const s = layout?.screen;
	if (!s) return;
	let fx = (x - 1 - s.col * cell.w) / (s.c * cell.w);
	let fy = (y - 1 - s.row * cell.h) / (s.r * cell.h);
	if (clamp) [fx, fy] = [Math.min(1, Math.max(0, fx)), Math.min(1, Math.max(0, fy))];
	return fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1 ? { fx, fy } : undefined;
}

let press: { x: number; y: number; t: number } | undefined;
function onMouse(button: number, x: number, y: number, released: boolean) {
	if (button === 0 && !released) press = { x, y, t: Date.now() };
	if (!released || !press) return;
	const start = onScreen(press.x, press.y);
	const end = onScreen(x, y, true)!;
	const moved = Math.hypot(x - press.x, y - press.y);
	const seconds = Math.min(1.5, Math.max(0.1, (Date.now() - press.t) / 1000)).toFixed(2);
	press = undefined;
	if (!start) return;
	takeTyped();
	// shortcut: a held click is a plain tap and a drag is a straight swipe; no long-press or curved paths.
	steps.push(({ w, h }) => {
		const [sx, sy, ex, ey] = [start.fx * w, start.fy * h, end.fx * w, end.fy * h].map((n) => n.toFixed(1));
		return moved < 8 ? `tap -x ${sx} -y ${sy}` : `swipe --start-x ${sx} --start-y ${sy} --end-x ${ex} --end-y ${ey} --duration ${seconds}`;
	});
	run();
}

// Printable keys are typed as text; these go as HID keycodes.
const KEYS: Record<string, string> = { "\r": "40", "\x7f": "42", "\t": "43", "\x1b[A": "82", "\x1b[B": "81", "\x1b[D": "80", "\x1b[C": "79" };

function onInput(d: Buffer) {
	for (const [tok, b, x, y, kind] of d.toString("latin1").matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[[ABCD]|[\s\S]/g)) {
		if (kind) onMouse(Number(b), Number(x), Number(y), kind === "m");
		else if (tok === "\x03") quit();
		else if (KEYS[tok] || (tok >= " " && tok <= "~")) {
			if (KEYS[tok]) {
				takeTyped();
				steps.push(() => `key ${KEYS[tok]}`);
			} else typed += tok;
			clearTimeout(typingTimer);
			typingTimer = setTimeout(flush, 150);
		}
	}
}

process.stdin.setRawMode(true);
process.stdin.resume();
await queryTerminal();
process.stdin.on("data", onInput);
out.on("drain", update);
out.on("resize", () => {
	layout = undefined;
	shown = undefined;
	update();
});
process.on("SIGTERM", quit);
process.on("SIGHUP", quit);
// Mouse reporting: 1000 press/release, 1006 SGR encoding, 1016 positions in pixels.
out.write(`${ESC}[?25l${ESC}[2J${ESC}[?1000h${ESC}[?1006h${ESC}[?1016h`);
stream();
