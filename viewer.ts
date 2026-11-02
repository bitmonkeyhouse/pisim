// Shows a simulator in the current terminal pane via the Kitty graphics protocol.
// Usage: node viewer.ts <udid> [label]
import { rmSync } from "node:fs";
import { type Bezel, fits, frame, loadBezel } from "./bezel.ts";
import { screenshot } from "./sim.ts";

const [udid, label = udid] = process.argv.slice(2);
if (!udid) {
	console.error("usage: node viewer.ts <udid> [label]");
	process.exit(2);
}

const ESC = "\x1b";
const out = process.stdout;
let cell = { w: 8, h: 16 }; // fallback if the terminal doesn't answer CSI 16 t
let last: Buffer | undefined;
let dirty = true;
let bezel: Bezel | null | undefined; // null when the device has no usable bezel

function quit() {
	if (bezel) rmSync(bezel.dir, { recursive: true, force: true });
	out.write(`${ESC}_Ga=d,d=I,i=1,q=2${ESC}\\${ESC}[?25h${ESC}[2J${ESC}[H`);
	process.exit(0);
}

// Ask the terminal for its cell size in pixels: reply is ESC [ 6 ; h ; w t
function queryCellSize(): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, 300);
		process.stdin.once("data", (d) => {
			const m = /\x1b\[6;(\d+);(\d+)t/.exec(d.toString());
			if (m) cell = { h: Number(m[1]), w: Number(m[2]) };
			clearTimeout(timer);
			resolve();
		});
		out.write(`${ESC}[16t`);
	});
}

// Largest cols x rows box that keeps the image's aspect ratio inside the pane, less a margin of
// 2 cols each side and 1 row top and bottom, plus where to place it so it's centred.
function fit(png: Buffer) {
	const w = png.readUInt32BE(16);
	const h = png.readUInt32BE(20);
	const cols = Math.max(1, out.columns - 4);
	const rows = Math.max(1, out.rows - 2);
	const scale = Math.min((cols * cell.w) / w, (rows * cell.h) / h);
	const c = Math.max(1, Math.floor((w * scale) / cell.w));
	const r = Math.max(1, Math.floor((h * scale) / cell.h));
	return { c, r, col: Math.floor((out.columns - c) / 2) + 1, row: Math.floor((out.rows - r) / 2) + 1 };
}

function draw(png: Buffer) {
	const { c, r, col, row } = fit(png);
	const data = png.toString("base64");
	let s = `${ESC}[${row};${col}H`;
	for (let i = 0; i < data.length; i += 4096) {
		const more = i + 4096 < data.length ? 1 : 0;
		const head = i === 0 ? `a=T,f=100,i=1,p=1,c=${c},r=${r},C=1,q=2,m=${more}` : `m=${more}`;
		s += `${ESC}_G${head};${data.slice(i, i + 4096)}${ESC}\\`;
	}
	out.write(s);
}

async function loop() {
	for (;;) {
		try {
			const png = await screenshot(udid);
			if (dirty || !last?.equals(png)) {
				bezel ??= await loadBezel(udid, Math.min(png.readUInt32BE(16), png.readUInt32BE(20))).catch(() => null);
				draw(bezel && fits(bezel, png) ? await frame(bezel, png).catch(() => png) : png);
			}
			last = png;
			dirty = false;
		} catch (e) {
			out.write(`${ESC}[2J${ESC}[H${label}: ${(e as Error).message.split("\n")[0]}\r\n(retrying)`);
			dirty = true;
			await new Promise((r) => setTimeout(r, 1000));
		}
	}
}

process.stdin.setRawMode(true);
process.stdin.resume();
await queryCellSize();
process.stdin.on("data", (d) => {
	if (d[0] === 0x71 || d[0] === 0x03) quit(); // q or ctrl-c
});
out.on("resize", () => {
	out.write(`${ESC}[2J`);
	dirty = true;
});
process.on("SIGTERM", quit);
process.on("SIGHUP", quit);
out.write(`${ESC}[?25l${ESC}[2J`);
loop();
