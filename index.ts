import { type ChildProcess, execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { type AXNode, BUTTONS, buttonLines, describe, type Device, keyLines, keymap, listBooted, screenshot, simctl, startHid, uiTree } from "./sim.ts";

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

	// One simhelper hid per simulator, started on first use and kept until pi exits; dropped if it dies.
	const hids = new Map<string, Promise<ChildProcess>>();
	async function hidSend(udid: string, lines: string[]) {
		let hid = hids.get(udid);
		if (!hid) {
			hid = startHid(udid);
			hids.set(udid, hid);
			hid.then((p) => p.on("close", () => hids.delete(udid)), () => hids.delete(udid));
		}
		(await hid).stdin!.write(lines.map((l) => `${l}\n`).join(""));
	}
	pi.on("session_shutdown", () => {
		for (const hid of hids.values()) hid.then((p) => p.kill(), () => {});
	});
	const keymaps = new Map<string, ReturnType<typeof keymap>>();

	// Where to tap, as fractions of the display buffer: the given point, or the centre of the element
	// with the label (or id), polling the accessibility tree for up to 3s for it to appear.
	async function tapPoint(udid: string, t: { label?: string; id?: string; x?: number; y?: number }) {
		for (const deadline = Date.now() + 3000; ; ) {
			const roots = await uiTree(udid);
			const screen = roots[0]?.frame;
			if (!screen) throw new Error("Couldn't read the screen size from the accessibility tree");
			// On a foldable's inner display the root is portrait, as its buffer is, but elements are laid
			// out landscape: the buffer is the interface turned a quarter anticlockwise (`turn`, from simhelper).
			const wide = roots[0].turn === 1;
			const at = (x: number, y: number) => (wide ? [y / screen.width, 1 - x / screen.height] : [x / screen.width, y / screen.height]);
			if (t.x !== undefined && t.y !== undefined) return at(t.x, t.y);
			const found = new Map<string, NonNullable<AXNode["frame"]>>(); // by frame, as elements can repeat
			const walk = (n: AXNode) => {
				if (n.frame && (t.label !== undefined ? n.AXLabel === t.label : n.AXUniqueId === t.id)) found.set(JSON.stringify(n.frame), n.frame);
				n.children?.forEach(walk);
			};
			roots.forEach(walk);
			const what = t.label !== undefined ? `label "${t.label}"` : `id "${t.id}"`;
			// Matches nested inside one of them (a button and its icon and text) are the same control.
			const frames = [...found.values()];
			const contains = (a: (typeof frames)[0], b: (typeof frames)[0]) =>
				a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height;
			const f = frames.find((a) => frames.every((b) => contains(a, b)));
			if (frames.length && !f) throw new Error(`${frames.length} separate elements have ${what}; tap by x,y instead (see sim_describe)`);
			if (f) return at(f.x + f.width / 2, f.y + f.height / 2);
			if (Date.now() > deadline) throw new Error(`No element with ${what} on screen`);
			await new Promise((r) => setTimeout(r, 250));
		}
	}

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
			if ((x === undefined || y === undefined) && l === undefined && id === undefined) throw new Error("sim_tap needs label, id, or both x and y");
			const { udid } = await pick(params.device ?? "", ctx);
			const at = (await tapPoint(udid, params)).map((n) => n.toFixed(4)).join(" ");
			await hidSend(udid, [`down ${at}`, `up ${at}`]);
			return done(udid, `Tapped ${x !== undefined && y !== undefined ? `${x},${y}` : l !== undefined ? `"${l}"` : `id=${id}`}`);
		},
	});

	pi.registerTool({
		name: "sim_type",
		label: "Simulator type",
		description:
			"Type text into the focused field of a booted iOS simulator (tap the field first). Newlines press Return. Only characters on the simulator's hardware keyboard layout (US or British) can be typed.",
		promptSnippet: "Type text into a booted iOS simulator",
		parameters: Type.Object({ text: Type.String({ description: "Text to type" }), device }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { udid } = await pick(params.device ?? "", ctx);
			if (!keymaps.has(udid)) keymaps.set(udid, keymap(udid));
			const keys = await keymaps.get(udid)!;
			const missing = [...new Set([...params.text].filter((c) => !keys.has(c)))];
			if (missing.length) throw new Error(`Can't type ${missing.map((c) => JSON.stringify(c)).join(", ")} on the simulator's keyboard layout`);
			await hidSend(udid, [...params.text].flatMap((c) => keyLines(keys.get(c)!)));
			return done(udid, `Typed ${JSON.stringify(params.text)}`);
		},
	});

	pi.registerTool({
		name: "sim_button",
		label: "Simulator button",
		description: "Press a hardware button on a booted iOS simulator: home (go to the home screen), lock (side button: lock or wake), siri, volume-up or volume-down.",
		promptSnippet: "Press a hardware button (home, lock, siri, volume) on a booted iOS simulator",
		parameters: Type.Object({ button: StringEnum(Object.keys(BUTTONS) as (keyof typeof BUTTONS)[]), device }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { udid } = await pick(params.device ?? "", ctx);
			await hidSend(udid, buttonLines(params.button));
			return done(udid, `Pressed ${params.button}`);
		},
	});

	// Hinge angles in degrees: Device Hub's Open, Closed and Book presets.
	const FOLDS = { open: 180, closed: 0, partial: 130 } as const;

	pi.registerTool({
		name: "sim_fold",
		label: "Simulator fold",
		description:
			"Fold a foldable iOS simulator (iPhone Duo): open (flat, the inner display), closed (the outer display) or partial (half-folded like a book, the inner display). Waits until the device has moved to that display, so sim_describe, sim_tap and sim_screenshot then act on it.",
		promptSnippet: "Open, close or half-fold a foldable iOS simulator (iPhone Duo)",
		parameters: Type.Object({ state: StringEnum(Object.keys(FOLDS) as (keyof typeof FOLDS)[]), device }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const { udid, name } = await pick(params.device ?? "", ctx);
			if (((await uiTree(udid))[0]?.displays ?? 1) < 2) throw new Error(`${name} doesn't fold`);
			await hidSend(udid, [`hinge ${FOLDS[params.state]}`]);
			// The inner display takes over within about a second of opening; the outer one, of closing.
			const inner = params.state !== "closed";
			for (const deadline = Date.now() + 8000; Date.now() < deadline && !signal?.aborted; await new Promise((r) => setTimeout(r, 300))) {
				if (((await uiTree(udid))[0]?.turn === 1) === inner) return done(udid, `${name} is ${params.state}; the ${inner ? "inner" : "outer"} display is in use`);
			}
			throw new Error(`${name} didn't move to its ${inner ? "inner" : "outer"} display within 8s`);
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
