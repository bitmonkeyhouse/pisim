// Wraps simulator screenshots in the device bezel Xcode ships for Simulator.app.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { helper } from "./sim.ts";

const run = promisify(execFile);

// In framebuffer pixels: whole bezel w x h, screen hole at x,y sized hw x hh, turned clockwise by
// `quarter` quarter turns (0 = portrait, as loaded). `scale` is framebuffer pixels per PDF point;
// `stretched` frames are drawn stretched to their size rather than scaled (see stretchBezel).
export type Bezel = {
	pdf: string;
	dir: string;
	w: number;
	h: number;
	x: number;
	y: number;
	hw: number;
	hh: number;
	quarter: number;
	scale: number;
	stretched?: boolean;
};

// The Resources directory of the simulator's device type bundle (profile.plist, capabilities.plist).
async function deviceResources(udid: string): Promise<string> {
	const json = async (...args: string[]) => JSON.parse((await run("xcrun", ["simctl", "list", ...args, "-j"])).stdout);
	const devices = Object.values((await json("devices")).devices).flat() as { udid: string; deviceTypeIdentifier: string }[];
	const type = devices.find((d) => d.udid === udid)!.deviceTypeIdentifier;
	const types = (await json("devicetypes")).devicetypes as { identifier: string; bundlePath: string }[];
	return join(types.find((t) => t.identifier === type)!.bundlePath, "Contents/Resources");
}

async function screenCapability(udid: string, key: string): Promise<number> {
	const caps = join(await deviceResources(udid), "capabilities.plist");
	return Number((await run("plutil", ["-extract", `capabilities.ScreenDimensionsCapability.${key}`, "raw", caps])).stdout);
}

// The device's screen density: framebuffer pixels per inch (460 for recent iPhones, 264 for iPads).
export const screenPitch = (udid: string) => screenCapability(udid, "main-screen-pitch");

// Measures the device's bezel (DeviceKit chrome composite) at the device's screen scale (framebuffer
// pixels per point), or failing that the scale where its screen hole is `shotWidth` pixels wide.
export async function loadBezel(udid: string, shotWidth: number): Promise<Bezel> {
	const profile = join(await deviceResources(udid), "profile.plist");
	const chrome = (await run("plutil", ["-extract", "chromeIdentifier", "raw", profile])).stdout.trim();
	const res = `/Library/Developer/DeviceKit/Chrome/${chrome.split(".").pop()}.devicechrome/Contents/Resources`;
	const { composite, sizing: s } = JSON.parse(await readFile(join(res, "chrome.json"), "utf8")).images;
	const pdf = join(res, `${composite}.pdf`);

	const dir = await mkdtemp(join(tmpdir(), "pisim-bezel-"));
	const [ptW, ptH] = (await run(await helper(), ["bezel-size", pdf])).stdout.trim().split(" ").map(Number);
	const pt = { w: ptW, h: ptH };
	const scale = (await screenCapability(udid, "main-screen-scale").catch(() => 0)) || shotWidth / (pt.w - s.leftWidth - s.rightWidth);
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
		quarter: 0,
		scale,
	};
}

// The portrait bezel turned clockwise by q quarter turns: turning clockwise moves the left edge to
// the top and the bottom edge to the left.
export function turnBezel(b: Bezel, q: number): Bezel {
	const right = b.w - b.x - b.hw;
	const bottom = b.h - b.y - b.hh;
	const odd = q % 2 === 1;
	const [x, y] = [[b.x, b.y], [bottom, b.x], [right, bottom], [b.y, right]][q % 4];
	return { ...b, x, y, w: odd ? b.h : b.w, h: odd ? b.w : b.h, hw: odd ? b.hh : b.hw, hh: odd ? b.hw : b.hh, quarter: q % 4 };
}

// The portrait bezel's frame, as thick as it is, around a portrait screen of another shape (a
// foldable's inner display): simhelper builds it from the frame's right side, its left being the
// folded Duo's hinge, so both sides are as thick as the right.
export function stretchBezel(b: Bezel, hw: number, hh: number): Bezel {
	const side = b.w - b.x - b.hw;
	const bottom = b.h - b.y - b.hh;
	return { ...b, hw, hh, x: side, w: side + hw + side, h: b.y + hh + bottom, quarter: 0, stretched: true };
}

// Bezel frames fit the screen they were drawn for; others get a stretched frame.
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
	const stretch = bezel.stretched ? [String(bezel.scale * (o.w / bezel.w))] : []; // pixels per PDF point, as drawn
	await run(await helper(), ["bezel", bezel.pdf, mask, file, ...nums, o.background, String(bezel.quarter), ...stretch]);
	return readFile(file);
}
