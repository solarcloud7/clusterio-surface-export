// canvas-bundle — compare the built web bundle against the one a page loaded.
// requires: dist/web/manifest.json, a playwright page with the plugin UI mounted
// produces: bundleOnDisk(), bundleInPage(page), assertPageMatchesDisk(page) — throws on mismatch
// does not: identify WHY they differ, or check any behaviour of either build
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../docker/seed-data/external_plugins/surface_export",
);

export function bundleOnDisk() {
	const manifestPath = path.join(PLUGIN_DIR, "dist/web/manifest.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const entry = manifest["surface_export.js"];
	if (!entry) {
		throw new Error(`no "surface_export.js" entry in ${manifestPath} — has the web bundle been built?`);
	}
	return entry.split("/").pop();
}

export async function assertControllerBundle(base = process.env.SE_WEB_URL || "http://localhost:8080", {
	fetcher = fetch, expected = bundleOnDisk(),
} = {}) {
	const response = await fetcher(new URL("/api/plugins", base), { signal: AbortSignal.timeout(10000) });
	if (!response.ok) throw new Error(`Controller readiness: /api/plugins returned ${response.status}`);
	const plugins = await response.json();
	const plugin = plugins.find(p => p.name === "surface_export");
	const advertised = plugin?.web?.main ?? plugin?.web?.["surface_export.js"];
	if (!plugin || plugin.enabled === false || plugin.loaded === false || !advertised || advertised.split("/").pop() !== expected) {
		throw new Error(`Controller bundle readiness: expected ${expected}, advertised ${advertised ?? "plugin unavailable"}. Run deploy.ps1 -Scope artifacts -Target web -RestartController.`);
	}
}

export async function bundleInPage(page) {
	return page.evaluate(() => {
		const script = [...document.querySelectorAll('script[src*="surface_export."]')]
			.map(tag => tag.src.split("/").pop())
			.find(name => name.endsWith(".js"));
		return script || null;
	});
}

export async function assertPageMatchesDisk(page, { context = "canvas" } = {}) {
	const disk = bundleOnDisk();
	const loaded = await bundleInPage(page);
	if (loaded !== disk) {
		throw new Error(
			`${context}: the page is running a DIFFERENT build than the one on disk.\n`
			+ `  on disk (dist/web/manifest.json): ${disk}\n`
			+ `  loaded by the page:               ${loaded ?? "(no surface_export chunk found)"}\n`
			+ "Every measurement from this page describes code you are not looking at. Re-deploy "
			+ "(./tools/clusterio/deploy.ps1 -Scope artifacts -Target web -RestartController) and "
			+ "reload — and if the mismatch persists, someone else is deploying into this cluster.",
		);
	}
	return disk;
}
