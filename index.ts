import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { axe, describe, type Device, listBooted, screenshot, simctl } from "./sim.ts";

const run = promisify(execFile);
const viewer = join(dirname(fileURLToPath(import.meta.url)), "viewer.ts");
const label = (d: Device) => `${d.name} (${d.runtime})`;
const device = Type.Optional(Type.String({ description: "Simulator name or udid; defaults to the one opened with /sim or the only booted one" }));

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
			device,
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

	const done = (udid: string, text: string) => ({ content: [{ type: "text" as const, text }], details: { udid } });

	pi.registerTool({
		name: "sim_describe",
		label: "Simulator UI",
		description:
			"List the accessibility elements on a booted iOS simulator's screen, one per line: type, label, id, value and frame as @x,y wxh in points (origin top-left). Use it to find targets for sim_tap.",
		promptSnippet: "List the on-screen UI elements of a booted iOS simulator",
		parameters: Type.Object({ device }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { udid } = await pick(params.device ?? "", ctx);
			return done(udid, await describe(udid));
		},
	});

	pi.registerTool({
		name: "sim_tap",
		label: "Simulator tap",
		description:
			"Tap on a booted iOS simulator, either an element by accessibility label or id (waits up to 3s for it to appear), or a point x,y in points (origin top-left, as reported by sim_describe; screenshot pixels divided by the device scale).",
		promptSnippet: "Tap an element or point on a booted iOS simulator",
		promptGuidelines: ["After sim_tap or sim_type, check the result with sim_describe or sim_screenshot; taps are fire-and-forget."],
		parameters: Type.Object({
			label: Type.Optional(Type.String({ description: "Accessibility label of the element to tap" })),
			id: Type.Optional(Type.String({ description: "Accessibility identifier of the element to tap" })),
			x: Type.Optional(Type.Number({ description: "X in points" })),
			y: Type.Optional(Type.Number({ description: "Y in points" })),
			device,
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { label: l, id, x, y } = params;
			const target =
				x !== undefined && y !== undefined ? ["-x", String(x), "-y", String(y)]
				: l ? ["--label", l, "--wait-timeout", "3"]
				: id ? ["--id", id, "--wait-timeout", "3"]
				: undefined;
			if (!target) throw new Error("sim_tap needs label, id, or both x and y");
			const { udid } = await pick(params.device ?? "", ctx);
			await axe("tap", ...target, "--udid", udid);
			return done(udid, `Tapped ${l ? `"${l}"` : id ? `id=${id}` : `${x},${y}`}`);
		},
	});

	pi.registerTool({
		name: "sim_type",
		label: "Simulator type",
		description: "Type text into the focused field of a booted iOS simulator (tap the field first). US keyboard characters only.",
		promptSnippet: "Type text into a booted iOS simulator",
		parameters: Type.Object({ text: Type.String({ description: "Text to type" }), device }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { udid } = await pick(params.device ?? "", ctx);
			await axe("type", "--udid", udid, "--", params.text);
			return done(udid, `Typed ${JSON.stringify(params.text)}`);
		},
	});

	pi.registerTool({
		name: "sim_launch",
		label: "Simulator launch",
		description: "Launch an installed app by bundle identifier on a booted iOS simulator; set restart to terminate a running copy first (e.g. after installing a new build).",
		promptSnippet: "Launch an app on a booted iOS simulator",
		parameters: Type.Object({
			bundle_id: Type.String({ description: "App bundle identifier, e.g. com.example.app" }),
			restart: Type.Optional(Type.Boolean({ description: "Terminate the app first if it's running" })),
			device,
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { udid } = await pick(params.device ?? "", ctx);
			const flags = params.restart ? ["--terminate-running-process"] : [];
			return done(udid, (await simctl("launch", ...flags, udid, params.bundle_id)).trim());
		},
	});

	pi.registerTool({
		name: "sim_open_url",
		label: "Simulator open URL",
		description: "Open a URL (web link, deep link or custom URL scheme) on a booted iOS simulator.",
		promptSnippet: "Open a URL or deep link on a booted iOS simulator",
		parameters: Type.Object({ url: Type.String({ description: "URL to open, e.g. myapp://settings" }), device }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { udid } = await pick(params.device ?? "", ctx);
			await simctl("openurl", udid, params.url);
			return done(udid, `Opened ${params.url}`);
		},
	});
}
