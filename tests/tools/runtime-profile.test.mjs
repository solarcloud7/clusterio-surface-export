import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { resolveRuntimeProfile, resolveImages } from "../../tools/shared/runtime-profile.mjs";
import { DockerLab } from "../manual/transfer-reliability/docker-lab.mjs";
import { ConsumerLab, parseExportAssets } from "../manual/consumer-install/lab.mjs";
import artifacts from "../manual/consumer-install/artifacts.cjs";

test("consumer asset discovery excludes similarly indented mod settings", () => {
	const details = "settings:\n  runtime-global:\n    surfexp-platform-boarding: true\nexportManifest:\n  assets:\n    prototypes: prototypes.123.json\n    spritesheet: spritesheet.456.png\nupdatedAtMs: 123\n";
	for (const text of [details, details.replaceAll("\n", "\r\n")]) {
		assert.deepEqual(parseExportAssets(text), {prototypes: "prototypes.123.json", spritesheet: "spritesheet.456.png"});
	}
	assert.throws(() => parseExportAssets("settings:\n  runtime-global:\n    prototypes: wrong.json\n"), /manifest missing/);
});

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "se-runtime-profile-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const write = (path, value) => {
		const file = join(root, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
	};
	write(".env.example", "CLUSTERIO_IMAGE_TAG=2.0.0-alpha.27.r7\n");
	write("docker/seed-data/hosts/host-1/instance-1/instance.json", { "factorio.version": "2.1.20" });
	write("docker/seed-data/hosts/host-2/instance-2/instance.json", { "factorio.version": "2.1.20" });
	write("docker/seed-data/external_plugins/surface_export/package.json", { version: "0.11.0-beta.3" });
	write("docker/seed-data/mods-src/surfexp_gateways/info.json", { version: "0.6.7" });
	return { root, write };
}

test("runtime selection follows the selected package and seed pins, ignoring local env", t => {
	const { root, write } = fixture(t);
	write(".env", "CLUSTERIO_IMAGE_TAG=latest\nFACTORIO_VERSION=1.0.0");
	write("candidate/package.json", { version: "0.12.0-beta.1" });
	const profile = resolveRuntimeProfile({ root, packageDirectory: join(root, "candidate") });
	assert.equal(profile.factorioVersion, "2.1.20");
	assert.equal(profile.pluginVersion, "0.12.0-beta.1");
	assert.equal(profile.gatewayVersion, "0.6.7");
	assert.equal(profile.imageTag, "2.0.0-alpha.27.r7");
	assert.equal(profile.clusterioVersion, "2.0.0-alpha.27");
	assert.ok(Object.isFrozen(profile));
});

test("disagreeing seed pins fail unless the run explicitly selects an engine", t => {
	const { root, write } = fixture(t);
	write("docker/seed-data/hosts/host-2/instance-2/instance.json", { "factorio.version": "2.1.17" });
	assert.throws(() => resolveRuntimeProfile({ root }), /seed engine versions disagree/);
	assert.equal(resolveRuntimeProfile({ root, factorioVersion: "2.1.17", gatewayVersion: "0.6.6" }).gatewayVersion, "0.6.6");
	for (const factorioVersion of ["latest", "experimental", "", "2.1", "2.1.20/../"])
		assert.throws(() => resolveRuntimeProfile({ root, factorioVersion }), /exact Factorio/);
});

test("image-only checks do not require a plugin build and reject mutable tags", t => {
	const { root } = fixture(t);
	for (const imageTag of ["latest", "main", "2.0.0-alpha.27", ""])
		assert.throws(() => resolveImages({ root, imageTag }), /immutable/);
	assert.equal(resolveImages({ root, imageTag: "2.0.0-alpha.27-r1" }).hostImage,
		"ghcr.io/solarcloud7/clusterio-docker-host:2.0.0-alpha.27-r1");
});

test("a lab retains one selection even if source metadata changes during the run", t => {
	const { root, write } = fixture(t);
	const lab = new DockerLab("se-manual-profile-12345678", "unused", { runtime: { root } });
	const profile = lab.runtimeProfile;
	write("docker/seed-data/mods-src/surfexp_gateways/info.json", { version: "0.6.8" });
	assert.strictEqual(lab.runtimeProfile, profile);
	assert.equal(lab.runtimeProfile.gatewayVersion, "0.6.7");
});

test("confirmed engine, companion and Lua mismatches fail after one observation", async t => {
	const { root } = fixture(t);
	for (const [field, value, component] of [["engine", "2.1.17", "Factorio"], ["gateway", undefined, "Companion"], ["plugin", "0.9.0", "Patched Lua"]]) {
		const lab = new DockerLab("se-manual-profile-12345678", "unused", { runtime: { root } });
		let calls = 0;
		lab.lua = () => {
			calls++;
			return { result: { engine: "2.1.20", gateway: "0.6.7", plugin: "0.11.0-beta.3", ready: true, players: 0, paused: false, [field]: value } };
		};
		await assert.rejects(lab.ready(10), error => error.retryable === false && error.message.includes(component));
		assert.equal(calls, 1);
	}
});

test("temporary connection failure still waits for matching running instances", async t => {
	const { root } = fixture(t);
	const lab = new DockerLab("se-manual-profile-12345678", "unused", { runtime: { root } });
	let calls = 0;
	lab.lua = () => {
		if (++calls === 1) throw new Error("not connected");
		return { result: { engine: "2.1.20", gateway: "0.6.7", plugin: "0.11.0-beta.3", ready: true, players: 0, paused: false } };
	};
	assert.equal(await lab.ready(10), true);
	assert.equal(calls, 3);
});

test("cold startup allowance does not lengthen ordinary control or RCON commands", () => {
	const lab = new DockerLab("se-manual-profile-12345678", "unused");
	const limits = [];
	lab.docker = (args, options) => { limits.push(options.timeout); return ""; };
	lab.ctl("instance", "start", "fixture", "--save", "fixture.zip");
	lab.ctl("instance", "list");
	lab.ctl("instance", "send-rcon", "fixture", "/sc rcon.print('ok')");
	assert.deepEqual(limits, [180_000, 30_000, 30_000]);
});

test("consumer metadata is read from archive contents, including folder and engine compatibility", async () => {
	const pkg = {name: "@solarcloud7/plugin-surface-export", version: "0.12.0-beta.1"};
	const info = {name: "surfexp_gateways", version: "0.6.5", factorio_version: "2.1"};
	const zip = (name, value) => ({files: {[name]: {}}, file: () => ({async: async () => JSON.stringify(value)})});
	assert.deepEqual(await artifacts.inspectArtifacts(pkg, zip("surfexp_gateways_0.6.5/info.json", info)),
		{pluginVersion: pkg.version, gatewayVersion: "0.6.5", gatewayFactorioVersion: "2.1"});
	await assert.rejects(artifacts.inspectArtifacts(pkg, zip("surfexp_gateways_0.6.8/info.json", info)), /disagree/);
	await assert.rejects(artifacts.inspectArtifacts({...pkg, name: "unrelated"}, zip("surfexp_gateways_0.6.5/info.json", info)), /unexpected/);
});

test("consumer installation compares independently read input and installed versions", async t => {
	const {root} = fixture(t);
	for (const installedVersion of ["0.12.0-beta.1", "0.9.0"]) {
		const lab = new ConsumerLab("se-manual-profile-12345678", "unused", {runtime: {root}});
		lab.docker = args => {
			if (args[0] === "exec" && args.includes("/inspect-artifacts.cjs")) return JSON.stringify({pluginVersion: "0.12.0-beta.1", gatewayVersion: "0.6.5", gatewayFactorioVersion: "2.1"});
			if (args[0] === "exec" && args.includes("/bootstrap.mjs")) return JSON.stringify({packageVersion: installedVersion});
			if (args.includes("--version")) return "Version: 2.1.20 (linux64, full)";
			return "";
		};
		if (installedVersion === "0.9.0") await assert.rejects(lab.install("inputs", "fixture-client"), /Installed plugin version mismatch/);
		else {
			const result = await lab.install("inputs", "fixture-client");
			assert.equal(result.runtime.pluginVersion, "0.12.0-beta.1");
			assert.equal(result.runtime.gatewayVersion, "0.6.5");
		}
	}
});
