// Wraps simulator screenshots in the device bezel Xcode ships for Simulator.app.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const size = (png: Buffer) => ({ w: png.readUInt32BE(16), h: png.readUInt32BE(20) });

// In framebuffer pixels: whole bezel w x h, screen hole at x,y sized hw x hh.
export type Bezel = { pdf: string; dir: string; w: number; h: number; x: number; y: number; hw: number; hh: number };

// Measures the device's bezel (DeviceKit chrome composite) at the scale where its screen hole is `shotWidth` pixels wide.
export async function loadBezel(udid: string, shotWidth: number): Promise<Bezel> {
	const json = async (...args: string[]) => JSON.parse((await run("xcrun", ["simctl", "list", ...args, "-j"])).stdout);
	const devices = Object.values((await json("devices")).devices).flat() as { udid: string; deviceTypeIdentifier: string }[];
	const type = devices.find((d) => d.udid === udid)!.deviceTypeIdentifier;
	const types = (await json("devicetypes")).devicetypes as { identifier: string; bundlePath: string }[];
	const profile = join(types.find((t) => t.identifier === type)!.bundlePath, "Contents/Resources/profile.plist");
	const chrome = (await run("plutil", ["-extract", "chromeIdentifier", "raw", profile])).stdout.trim();
	const res = `/Library/Developer/DeviceKit/Chrome/${chrome.split(".").pop()}.devicechrome/Contents/Resources`;
	const { composite, sizing: s } = JSON.parse(await readFile(join(res, "chrome.json"), "utf8")).images;
	const pdf = join(res, `${composite}.pdf`);

	const dir = await mkdtemp(join(tmpdir(), "pisim-bezel-"));
	const file = join(dir, "bezel.png");
	await run("sips", ["-s", "format", "png", pdf, "--out", file]); // natural size, in points
	const pt = size(await readFile(file));
	const scale = shotWidth / (pt.w - s.leftWidth - s.rightWidth);
	const px = (n: number) => Math.round(n * scale);
	return {
		pdf,
		dir,
		w: px(pt.w),
		h: px(pt.h),
		x: px(s.leftWidth),
		y: px(s.topHeight),
		hw: px(pt.w - s.leftWidth - s.rightWidth),
		hh: px(pt.h - s.topHeight - s.bottomHeight),
	};
}

// Bezel frames are drawn for the portrait screen; anything else (rotation, foldables) is shown bare.
export function fits(bezel: Bezel, w: number, h: number): boolean {
	return Math.abs(w / h / (bezel.hw / bezel.hh) - 1) < 0.02;
}

export type BezelRender = {
	w: number; // bezel size in pixels
	h: number;
	canvasW: number; // transparent canvas it's placed on, at padLeft,padTop
	canvasH: number;
	padLeft: number;
	padTop: number;
	holeX: number; // screen area on the canvas
	holeY: number;
	holeW: number;
	holeH: number;
	background: string; // ffmpeg colour, e.g. 0x1a1b26
};

// Renders the bezel as a PNG with the screen cut out (shape from a masked screenshot's alpha), so
// frames drawn underneath show through. Frames have square corners whose tips stick out past the
// bezel's rounded outline, so the cut-out's corners are filled with the terminal background.
export async function renderBezel(bezel: Bezel, maskedShot: Buffer, o: BezelRender): Promise<Buffer> {
	const file = join(bezel.dir, "bezel.png");
	const mask = join(bezel.dir, "mask.png");
	await run("sips", ["-s", "format", "png", "-z", String(o.h), String(o.w), bezel.pdf, "--out", file]);
	await writeFile(mask, maskedShot);
	const canvas = `${o.canvasW}:${o.canvasH}`;
	const graph =
		`[0]format=rgba,pad=${canvas}:${o.padLeft}:${o.padTop}:color=0x00000000,split[b][c];` +
		`[1]alphaextract,scale=${o.holeW}:${o.holeH},negate,split[n][n2];` +
		`[n]pad=${canvas}:${o.holeX}:${o.holeY}:color=white[m];` +
		`[b]alphaextract[a];[a][m]blend=all_mode=multiply[keep];[c][keep]alphamerge[bez];` +
		`color=c=${o.background}:s=${o.holeW}x${o.holeH}:d=1,format=rgba[bg];` +
		`[bg][n2]alphamerge,pad=${canvas}:${o.holeX}:${o.holeY}:color=0x00000000[corners];` +
		`[corners][bez]overlay=format=rgb`;
	const { stdout } = await run(
		"ffmpeg",
		["-v", "error", "-i", file, "-i", mask, "-filter_complex", graph, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-"],
		{ encoding: "buffer", maxBuffer: 64 << 20 },
	);
	return stdout;
}
