import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export type Device = { udid: string; name: string; runtime: string };

export async function listBooted(): Promise<Device[]> {
	const { stdout } = await run("xcrun", ["simctl", "list", "devices", "booted", "-j"]);
	const { devices } = JSON.parse(stdout) as { devices: Record<string, { udid: string; name: string }[]> };
	return Object.entries(devices).flatMap(([runtime, list]) =>
		list.map((d) => ({ udid: d.udid, name: d.name, runtime: runtime.split(".").pop()! })),
	);
}

// `simctl io screenshot -` doesn't write to stdout, so go through a temp file.
export async function screenshot(udid: string): Promise<Buffer> {
	const dir = await mkdtemp(join(tmpdir(), "pisim-"));
	try {
		const file = join(dir, "shot.png");
		await run("xcrun", ["simctl", "io", udid, "screenshot", "--type=png", "--mask=alpha", file]);
		return await readFile(file);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

export async function simctl(...args: string[]): Promise<string> {
	try {
		return (await run("xcrun", ["simctl", ...args])).stdout;
	} catch (e) {
		const err = e as Error & { stderr?: string };
		throw new Error(err.stderr?.trim() || err.message);
	}
}

export async function axe(...args: string[]): Promise<string> {
	try {
		return (await run("axe", args, { maxBuffer: 16 << 20 })).stdout;
	} catch (e) {
		const err = e as NodeJS.ErrnoException & { stderr?: string };
		if (err.code === "ENOENT") throw new Error("AXe is not installed: brew install cameroncooke/axe/axe");
		throw new Error(err.stderr?.trim() || err.message);
	}
}

export type AXNode = {
	type: string;
	AXLabel?: string | null;
	AXUniqueId?: string | null;
	AXValue?: string | null;
	enabled?: boolean;
	frame?: { x: number; y: number; width: number; height: number };
	children?: AXNode[];
};

// The accessibility tree, in points from the top-left; the first root is the app on screen.
export const uiTree = async (udid: string) => JSON.parse(await axe("describe-ui", "--udid", udid)) as AXNode[];

// `axe describe-ui` is ~80KB of JSON; condense to one line per labelled element, nested by depth.
export async function describe(udid: string): Promise<string> {
	const lines: string[] = [];
	const walk = (n: AXNode, depth: number) => {
		const named = n.AXLabel || n.AXUniqueId || n.AXValue;
		if (named) {
			const f = n.frame;
			let s = "  ".repeat(depth) + n.type;
			if (n.AXLabel) s += ` "${n.AXLabel}"`;
			if (n.AXUniqueId) s += ` id=${n.AXUniqueId}`;
			if (n.AXValue) s += ` value="${n.AXValue}"`;
			if (f) s += ` @${Math.round(f.x)},${Math.round(f.y)} ${Math.round(f.width)}x${Math.round(f.height)}`;
			if (n.enabled === false) s += " disabled";
			lines.push(s);
		}
		for (const c of n.children ?? []) walk(c, named ? depth + 1 : depth);
	};
	for (const n of await uiTree(udid)) walk(n, 0);
	return lines.join("\n");
}

// Native helpers, built with clang when missing or older than their source:
// simhid (simhid.m) sends touches and keys over one connection kept open to the simulator (a fresh
// connection per event costs ~0.5s); simvideo (simvideo.m) streams the display when it changes.
const here = dirname(fileURLToPath(import.meta.url));
const frameworks = { simhid: ["Foundation"], simvideo: ["Foundation", "IOSurface", "Metal", "MetalPerformanceShaders"] };

export async function helper(name: keyof typeof frameworks): Promise<string> {
	const src = join(here, `${name}.m`);
	const bin = join(here, name);
	if (!existsSync(bin) || statSync(bin).mtimeMs < statSync(src).mtimeMs) {
		await run("clang", ["-fobjc-arc", ...frameworks[name].flatMap((f) => ["-framework", f]), src, "-o", bin]);
	}
	return bin;
}

// Starts simhid for a simulator, resolving once it's connected. Write lines to its stdin:
// "down|move|up <x> <y>" (fractions of the screen) or "key <usage> down|up".
export async function startHid(udid: string): Promise<ChildProcess> {
	const bin = await helper("simhid");
	return new Promise((resolve, reject) => {
		let err = "";
		const p = spawn(bin, [udid], { stdio: ["pipe", "pipe", "pipe"] });
		p.stdin!.on("error", () => {}); // a dead helper is reported by "close"
		p.stderr!.on("data", (d) => (err += d));
		p.stdout!.once("data", () => resolve(p));
		p.on("close", () => reject(new Error(err.trim().split("\n").pop() || "simhid exited")));
	});
}

const SHIFT = 225;
const ALT = 226;

// Characters (and arrow-key escape sequences) to HID usages with the modifiers held for them.
// US layout: the character at index i is usage 4 + i, unshifted then shifted ("\0" = none).
export async function keymap(udid: string): Promise<Map<string, number[]>> {
	const keys = new Map<string, number[]>(); // char -> [...modifiers, usage]
	[..."abcdefghijklmnopqrstuvwxyz1234567890\r\x1b\x7f\t -=[]\\\0;'`,./"].forEach((c, i) => keys.set(c, [4 + i]));
	[..."ABCDEFGHIJKLMNOPQRSTUVWXYZ!@#$%^&*()\0\0\0\0\0_+{}|\0:\"~<>?"].forEach((c, i) => keys.set(c, [SHIFT, 4 + i]));
	for (const [seq, usage] of [["\x1b[C", 79], ["\x1b[D", 80], ["\x1b[B", 81], ["\x1b[A", 82], ["\n", 40]] as const) keys.set(seq, [usage]);
	keys.delete("\0");
	// The simulator types with its own hardware keyboard layout, and en_GB simulators use British:
	// Shift+3 is £, # is Option+3, and § ± are on the ISO key by left Shift (usage 100).
	// shortcut: only US and British are mapped; other layouts type the wrong punctuation, upgrade by reading
	// the simulator's hardware keyboard layout setting.
	const locale = await simctl("spawn", udid, "defaults", "read", "-g", "AppleLocale").catch(() => "");
	if (locale.includes("_GB")) {
		for (const [c, k] of [["£", [SHIFT, 32]], ["#", [ALT, 32]], ["§", [100]], ["±", [SHIFT, 100]]] as const) keys.set(c, [...k]);
	}
	return keys;
}

// simhid lines that press and release a key with its modifiers.
export const keyLines = (keys: number[]) => [...keys.map((k) => `key ${k} down`), ...keys.toReversed().map((k) => `key ${k} up`)];
