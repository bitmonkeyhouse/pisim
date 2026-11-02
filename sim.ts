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
