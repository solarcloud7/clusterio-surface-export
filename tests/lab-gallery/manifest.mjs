import { readFileSync } from "node:fs";

export function loadGalleryManifest(repoRoot) {
	return JSON.parse(readFileSync(new URL("tests/lab-gallery/manifest.json", repoRoot), "utf8"));
}

export function validateGalleryManifest(manifest) {
	if (manifest?.schema !== "surface-export-lab-gallery-v1") throw new Error("unexpected gallery schema");
	if (manifest.engineVersion !== "2.0.77") throw new Error(`unsupported gallery engine ${manifest.engineVersion}`);
	if (!/^lab-gallery-[a-z0-9-]+$/.test(manifest.saveName || "")) throw new Error("invalid extension-free gallery save name");
	if (!Array.isArray(manifest.labs) || manifest.labs.length === 0) throw new Error("gallery has no labs");
	const ids = new Set();
	const zones = new Set();
	let bakedSources = 0;
	for (const lab of manifest.labs) {
		if (!lab?.id || ids.has(lab.id)) throw new Error(`duplicate or missing lab id ${lab?.id}`);
		ids.add(lab.id);
		if (!lab.title || !lab.purpose || !lab.sourcePath) throw new Error(`incomplete lab ${lab.id}`);
		if (!Number.isInteger(lab.zone?.x) || !Number.isInteger(lab.zone?.y)) throw new Error(`invalid zone ${lab.id}`);
		const zone = `${lab.zone.x},${lab.zone.y}`;
		if (zones.has(zone)) throw new Error(`duplicate zone ${zone}`);
		zones.add(zone);
		if (lab.mode === "baked-source") bakedSources += 1;
		else if (lab.mode !== "catalog") throw new Error(`unsupported mode ${lab.mode} for ${lab.id}`);
	}
	return { labs: manifest.labs.length, bakedSources };
}
