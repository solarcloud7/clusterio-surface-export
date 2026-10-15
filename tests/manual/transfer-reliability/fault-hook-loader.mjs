// Module customization hooks registered by fault-hook.mjs; they run on Node's hooks thread.
// requires: registration through fault-hook.mjs; the instance entrypoint loaded as an ES module
// produces: the instance entrypoint's source with one appended statement that applies fault-hook-patch.mjs to its InstancePlugin class
// does not: change any other module, alter the entrypoint's exports, or decide which replies are held
export const INSTANCE_ENTRYPOINTS = ["/surface_export/dist/node/instance.js", "/@solarcloud7/plugin-surface-export/dist/node/instance.js"];

export function isInstanceEntrypoint(url) {
	const path = String(url).replace(/[?#].*$/, "");
	return INSTANCE_ENTRYPOINTS.some(suffix => path.endsWith(suffix));
}

export function patchStatement(patchUrl) {
	return `\n;await (await import(${JSON.stringify(patchUrl)})).patch(InstancePlugin);\n`;
}

export async function load(url, context, nextLoad) {
	const result = await nextLoad(url, context);
	if (!isInstanceEntrypoint(url) || result.format !== "module") return result;
	const source = typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
	return { ...result, source: source + patchStatement(new URL("./fault-hook-patch.mjs", import.meta.url).href) };
}
