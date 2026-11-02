// Wraps simulator screenshots in the device bezel Xcode ships for Simulator.app.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const size = (png: Buffer) => ({ w: png.readUInt32BE(16), h: png.readUInt32BE(20) });

export type Bezel = { file: string; dir: string; x: number; y: number; w: number; h: number }; // screen hole in pixels

// Renders the device's bezel (DeviceKit chrome composite) scaled so its screen hole is `shotWidth` pixels wide.
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
	await run("sips", ["-s", "format", "png", "-z", String(px(pt.h)), String(px(pt.w)), pdf, "--out", file]);
	return {
		file,
		dir,
		x: px(s.leftWidth),
		y: px(s.topHeight),
		w: px(pt.w - s.leftWidth - s.rightWidth),
		h: px(pt.h - s.topHeight - s.bottomHeight),
	};
}

// Bezel frames are drawn for the portrait screen; anything else (rotation, foldables) is shown bare.
export function fits(bezel: Bezel, shot: Buffer): boolean {
	const { w, h } = size(shot);
	return Math.abs(w / h / (bezel.w / bezel.h) - 1) < 0.02;
}

export async function frame(bezel: Bezel, shot: Buffer): Promise<Buffer> {
	const shotFile = join(bezel.dir, "shot.png");
	await writeFile(shotFile, shot);
	const { stdout } = await run(
		"ffmpeg",
		["-v", "error", "-i", bezel.file, "-i", shotFile, "-filter_complex", `[1]scale=${bezel.w}:${bezel.h}[s];[0][s]overlay=${bezel.x}:${bezel.y}`,
			"-f", "image2pipe", "-c:v", "png", "-compression_level", "1", "-"],
		{ encoding: "buffer", maxBuffer: 64 << 20 },
	);
	return stdout;
}
