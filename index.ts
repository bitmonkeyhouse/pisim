import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type Device, listBooted, screenshot } from "./sim.ts";

const run = promisify(execFile);
const viewer = join(dirname(fileURLToPath(import.meta.url)), "viewer.ts");
const label = (d: Device) => `${d.name} (${d.runtime})`;

export default function (pi: ExtensionAPI) {
	let current: Device | undefined; // last device opened with /sim; default for sim_screenshot

	// Match by name or udid; otherwise the only booted device, or ask when there are several.
	async function pick(query: string, ctx?: ExtensionContext): Promise<Device> {
		const booted = await listBooted();
		if (booted.length === 0) throw new Error("No booted simulators. Boot one with `xcrun simctl boot <udid>` or Simulator.app.");
		const q = query.trim().toLowerCase();
		if (q) {
			const hit = booted.find((d) => d.udid.toLowerCase() === q || d.name.toLowerCase() === q);
			if (!hit) throw new Error(`No booted simulator "${query}". Booted: ${booted.map(label).join(", ")}`);
			return hit;
		}
		if (current && booted.some((d) => d.udid === current!.udid)) return current;
		if (booted.length === 1) return booted[0];
		const choice = ctx?.hasUI ? await ctx.ui.select("Simulator", booted.map(label)) : undefined;
		const hit = booted.find((d) => label(d) === choice);
		if (!hit) throw new Error(`Several simulators booted, specify one: ${booted.map((d) => `${label(d)} ${d.udid}`).join(", ")}`);
		return hit;
	}

	pi.registerCommand("sim", {
		description: "Show a booted iOS simulator in a herdr pane",
		handler: async (args, ctx) => {
			const self = process.env.HERDR_PANE_ID;
			if (!self) return ctx.ui.notify("/sim needs to run inside herdr", "error");
			try {
				const device = await pick(args, ctx);
				current = device;
				const { stdout } = await run("herdr", ["pane", "split", self, "--direction", "right", "--ratio", "0.6"]);
				const pane = JSON.parse(stdout).result.pane.pane_id as string;
				await run("herdr", ["pane", "rename", pane, device.name]);
				const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
				await run("herdr", ["pane", "run", pane, `exec ${q(process.execPath)} ${q(viewer)} ${device.udid} ${q(device.name)}`]);
			} catch (e) {
				ctx.ui.notify((e as Error).message, "error");
			}
		},
	});

	pi.registerTool({
		name: "sim_screenshot",
		label: "Simulator screenshot",
		description: "Take a screenshot of a booted iOS simulator and return it as an image.",
		promptSnippet: "Capture the current screen of a booted iOS simulator",
		parameters: Type.Object({
			device: Type.Optional(Type.String({ description: "Simulator name or udid; defaults to the one opened with /sim or the only booted one" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const device = await pick(params.device ?? "", ctx);
			const png = await screenshot(device.udid);
			return {
				content: [
					{ type: "text", text: `Screenshot of ${label(device)} ${device.udid}` },
					{ type: "image", data: png.toString("base64"), mimeType: "image/png" },
				],
				details: { udid: device.udid },
			};
		},
	});
}
