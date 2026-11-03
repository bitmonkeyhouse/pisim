// Shows a simulator in the current terminal pane via the Kitty graphics protocol, and drives it:
// clicks tap, drags swipe, typing types. Frames stream from `axe stream-video` (~18 fps); the
// device bezel is a second image drawn on top. Ctrl-C quits.
// Usage: node viewer.ts <udid> [label]
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type Bezel, fits, loadBezel, renderBezel } from "./bezel.ts";
import { screenshot } from "./sim.ts";

const run = promisify(execFile);

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

// Input goes through simhid, which keeps one HID connection to the simulator open: a fresh
// connection per event (as with axe) costs ~0.5s. Built from simhid.m on first use.
const helperSrc = join(dirname(fileURLToPath(import.meta.url)), "simhid.m");
const helperBin = helperSrc.replace(/\.m$/, "");
let hid: ChildProcess | undefined;
let hidReady = false;
let statusShown = false;

function status(msg?: string) {
	if (msg || statusShown) out.write(`${ESC}[1;1H${ESC}[2K${msg ?? ""}`);
	statusShown = !!msg;
}

async function startHid() {
	try {
		if (!existsSync(helperBin) || statSync(helperBin).mtimeMs < statSync(helperSrc).mtimeMs) {
			await run("clang", ["-fobjc-arc", "-framework", "Foundation", helperSrc, "-o", helperBin]);
		}
	} catch (e) {
		return status(`couldn't build simhid: ${(e as Error).message.split("\n")[0]}`);
	}
	let err = "";
	hid = spawn(helperBin, [udid], { stdio: ["pipe", "pipe", "pipe"] });
	hid.stdin!.on("error", () => {}); // a dead helper is reported by "close"
	hid.stdout!.once("data", () => {
		hidReady = true;
		status();
	});
	hid.stderr!.on("data", (d) => (err += d));
	hid.on("close", () => {
		hidReady = false;
		status(err.trim().split("\n").pop() || "simhid stopped");
		setTimeout(startHid, 1000);
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

// Characters to HID usages with the modifiers held for them. US layout: the character at index i
// is usage 4 + i, unshifted then shifted ("\0" = none).
const SHIFT = 225;
const ALT = 226;
const KEYS = new Map<string, number[]>(); // char -> [...modifiers, usage]
[..."abcdefghijklmnopqrstuvwxyz1234567890\r\x1b\x7f\t -=[]\\\0;'`,./"].forEach((c, i) => KEYS.set(c, [4 + i]));
[..."ABCDEFGHIJKLMNOPQRSTUVWXYZ!@#$%^&*()\0\0\0\0\0_+{}|\0:\"~<>?"].forEach((c, i) => KEYS.set(c, [SHIFT, 4 + i]));
for (const [seq, usage] of [["\x1b[C", 79], ["\x1b[D", 80], ["\x1b[B", 81], ["\x1b[A", 82]] as const) KEYS.set(seq, [usage]);
KEYS.delete("\0");
// The simulator types with its own hardware keyboard layout, and en_GB simulators use British:
// Shift+3 is £, # is Option+3, and § ± are on the ISO key by left Shift (usage 100).
// shortcut: only US and British are mapped; other layouts type the wrong punctuation, upgrade by reading
// the simulator's hardware keyboard layout setting.
run("xcrun", ["simctl", "spawn", udid, "defaults", "read", "-g", "AppleLocale"]).then(
	({ stdout }) => {
		if (!stdout.includes("_GB")) return;
		for (const [c, keys] of [["£", [SHIFT, 32]], ["#", [ALT, 32]], ["§", [100]], ["±", [SHIFT, 100]]] as const) {
			KEYS.set(c, [...keys]);
		}
	},
	() => {},
);

function press(keys: number[]) {
	for (const k of keys) send(`key ${k} down`);
	for (const k of keys.toReversed()) send(`key ${k} up`);
}

function onInput(d: Buffer) {
	for (const [tok, b, x, y, kind] of d.toString().matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[[ABCD]|[\s\S]/g)) {
		if (kind) onMouse(Number(b), Number(x), Number(y), kind === "m");
		else if (tok === "\x03") quit();
		else if (KEYS.has(tok)) press(KEYS.get(tok)!);
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
// Mouse reporting: 1000 press/release, 1002 drags, 1006 SGR encoding, 1016 positions in pixels.
out.write(`${ESC}[?25l${ESC}[2J${ESC}[?1000h${ESC}[?1002h${ESC}[?1006h${ESC}[?1016h`);
stream();
startHid();
