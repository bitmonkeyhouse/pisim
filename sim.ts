import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
		// Xcode 27's dtuhidd drops input sent before it activates; AXe 1.8 needs the wait (AXe issue #71).
		return (await run("axe", args, { env: { ...process.env, AXE_HID_STABILIZATION_MS: "500" } })).stdout;
	} catch (e) {
		const err = e as NodeJS.ErrnoException & { stderr?: string };
		if (err.code === "ENOENT") throw new Error("AXe is not installed: brew install cameroncooke/axe/axe");
		throw new Error(err.stderr?.trim() || err.message);
	}
}

type AXNode = {
	type: string;
	AXLabel?: string | null;
	AXUniqueId?: string | null;
	AXValue?: string | null;
	enabled?: boolean;
	frame?: { x: number; y: number; width: number; height: number };
	children?: AXNode[];
};

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
	for (const n of JSON.parse(await axe("describe-ui", "--udid", udid)) as AXNode[]) walk(n, 0);
	return lines.join("\n");
}
