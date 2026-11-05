// Loaded with `node --import` for the viewer: strips TypeScript types itself, since Node refuses to
// for files under node_modules, which is where pi installs packages from npm.
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
	load(url, context, next) {
		if (!url.endsWith(".ts")) return next(url, context);
		return { format: "module", source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8")), shortCircuit: true };
	},
});
