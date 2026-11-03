// Wraps simulator screenshots in the device bezel Xcode ships for Simulator.app.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { helper } from "./sim.ts";

const run = promisify(execFile);

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
	const [ptW, ptH] = (await run(await helper(), ["bezel-size", pdf])).stdout.trim().split(" ").map(Number);
	const pt = { w: ptW, h: ptH };
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
	background: string; // rrggbb hex, e.g. 1a1b26
};

// Renders the bezel as a PNG with the screen cut out (shape from a masked screenshot's alpha), so
// frames drawn underneath show through; see simhelper.m.
export async function renderBezel(bezel: Bezel, maskedShot: Buffer, o: BezelRender): Promise<Buffer> {
	const file = join(bezel.dir, "bezel.png");
	const mask = join(bezel.dir, "mask.png");
	await writeFile(mask, maskedShot);
	const nums = [o.w, o.h, o.canvasW, o.canvasH, o.padLeft, o.padTop, o.holeX, o.holeY, o.holeW, o.holeH].map(String);
	await run(await helper(), ["bezel", bezel.pdf, mask, file, ...nums, o.background]);
	return readFile(file);
}
