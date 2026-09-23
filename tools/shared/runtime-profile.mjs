import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, seededInstances } from "./seeded-instances.mjs";

export const contract = {
	requires: ["seed instance configuration", ".env.example", "plugin package", "companion mod metadata"],
	produces: ["explicit immutable versions for a disposable acceptance run"],
	"does not": ["read credentials or local .env", "change deployment pins", "rewrite historical evidence"],
};

export function resolveImages({ root = REPO_ROOT, imageTag } = {}) {
	const tag = imageTag ?? readFileSync(join(root, ".env.example"), "utf8")
		.match(/^CLUSTERIO_IMAGE_TAG=(.+)$/m)?.[1].trim();
	assert.match(tag || "", /^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?[.-]r\d+$/, "immutable Clusterio image revision required");
	return Object.freeze({
		imageTag: tag,
		clusterioVersion: tag.replace(/[.-]r\d+$/, ""),
		controllerImage: `ghcr.io/solarcloud7/clusterio-docker-controller:${tag}`,
		hostImage: `ghcr.io/solarcloud7/clusterio-docker-host:${tag}`,
	});
}

export function resolveRuntimeProfile({ root = REPO_ROOT, packageDirectory, factorioVersion, gatewayVersion, imageTag } = {}) {
	const json = path => JSON.parse(readFileSync(path, "utf8"));
	const versions = seededInstances(root).map(h => json(join(root, "docker/seed-data/hosts", h.host, h.instance, "instance.json"))["factorio.version"]);
	if (factorioVersion === undefined) {
		assert.equal(new Set(versions).size, 1, "seed engine versions disagree; select an explicit Factorio version");
		factorioVersion = versions[0];
	}
	assert.match(factorioVersion || "", /^\d+\.\d+\.\d+$/, "exact Factorio version required");
	const pluginDirectory = packageDirectory ?? join(root, "docker/seed-data/external_plugins/surface_export");
	const pluginVersion = json(join(pluginDirectory, "package.json")).version;
	assert.match(pluginVersion || "", /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "exact plugin version required");
	const gateway = json(join(root, "docker/seed-data/mods-src/surfexp_gateways/info.json"));
	gatewayVersion ??= gateway.version;
	assert.match(gatewayVersion || "", /^\d+\.\d+\.\d+$/, "exact companion mod version required");
	return Object.freeze({ factorioVersion, pluginVersion, gatewayVersion, ...resolveImages({ root, imageTag }) });
}

export function assertRuntimeVersion(actual, expected, component) {
	if (actual !== expected) throw Object.assign(
		new Error(`${component} version mismatch: expected ${expected}, observed ${actual ?? "missing"}`),
		{ retryable: false },
	);
}
