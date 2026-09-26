import test from "node:test";
import assert from "node:assert/strict";
import { main, parseConfigList, parseModPackShow, planChanges } from "../../tools/clusterio/reconcile.mjs";

const SHOW = `id: 7
name: Space Age 2.1.20 - Test
description:
factorioVersion: 2.1.20
mods:
  ? base 2.1.20
  ? space-age 2.1.20
  surfexp_gateways 0.6.12 (a96c8f968f260f7c6aff1880e7394bdb1853f75d)
  (disabled) FluidMustFlow 1.5.0 (6c576d8d354cf930a64d79819af8f9b002583792)
settings:
  startup:
    surfexp-gateway-layout: "one_gate"
  runtime-global:
    surfexp-platform-boarding: true
  runtime-per-user:
exportManifest:
  assets:
    settings: settings.x.json
updatedAtMs: 1
isDeleted: false`;

const desired = {
	modPack: {
		name: "Space Age 2.1.20 - Test", factorioVersion: "2.1.20",
		mods: { base: "2.1.20", "space-age": "2.1.20", surfexp_gateways: "0.6.12", FluidMustFlow: "1.5.0" },
		sha1: { surfexp_gateways: "a96c8f968f260f7c6aff1880e7394bdb1853f75d", FluidMustFlow: "6c576d8d354cf930a64d79819af8f9b002583792" },
		settings: { startup: { "surfexp-gateway-layout": "one_gate" }, "runtime-global": { "surfexp-platform-boarding": true } },
	},
	controller: { "surface_export.gateway_mode": "one_gate" },
	instances: { fact1: { "surface_export.debug_mode": false } },
};
const hashes = { surfexp_gateways: "a96c8f968f260f7c6aff1880e7394bdb1853f75d", FluidMustFlow: "6c576d8d354cf930a64d79819af8f9b002583792" };
const modFile = (name, version) => ({ container: `/clusterio/seed-data/mods/${name}_${version}.zip`, sha1: hashes[name] });

function liveWith(overrides = {}) {
	return {
		packs: [{ id: 7, name: "Space Age 2.1.20 - Test" }],
		packDetails: { 7: parseModPackShow(SHOW) },
		mods: new Set(["surfexp_gateways_0.6.12", "FluidMustFlow_1.5.0"]),
		controller: { "surface_export.gateway_mode": "one_gate" },
		instances: { fact1: { "surface_export.debug_mode": false, "factorio.mod_pack_id": 7 } },
		...overrides,
	};
}

test("mod pack show and config list output parse into structured state", () => {
	const pack = parseModPackShow(SHOW);
	assert.equal(pack.id, 7);
	assert.equal(pack.factorioVersion, "2.1.20");
	assert.deepEqual(pack.mods.base, { version: "2.1.20", enabled: true, sha1: undefined });
	assert.deepEqual(pack.mods.FluidMustFlow, { version: "1.5.0", enabled: false, sha1: "6c576d8d354cf930a64d79819af8f9b002583792" });
	assert.deepEqual(pack.settings, { startup: { "surfexp-gateway-layout": "one_gate" }, "runtime-global": { "surfexp-platform-boarding": true }, "runtime-per-user": {} });
	assert.deepEqual(parseConfigList('instance.name "fact1"\ninstance.id 42\nsurface_export.debug_mode false\n'),
		{ "instance.name": "fact1", "instance.id": 42, "surface_export.debug_mode": false });
});

test("a missing pack plans uploads, a pinned create and deferred instance pointers", () => {
	const result = planChanges(desired, liveWith({ packs: [], packDetails: {}, mods: new Set() }), { modFile });
	assert.deepEqual(result.errors, []);
	assert.deepEqual(result.actions.map(action => action.argv.slice(0, 3)), [
		["mod", "upload", "/clusterio/seed-data/mods/surfexp_gateways_0.6.12.zip"],
		["mod", "upload", "/clusterio/seed-data/mods/FluidMustFlow_1.5.0.zip"],
		["mod-pack", "create", "Space Age 2.1.20 - Test"],
		["instance", "config", "set"],
	]);
	const create = result.actions[2].argv;
	assert.ok(create.includes("surfexp_gateways:0.6.12:a96c8f968f260f7c6aff1880e7394bdb1853f75d"));
	assert.ok(create.join(" ").includes("--string-setting startup surfexp-gateway-layout one_gate"));
	assert.ok(create.join(" ").includes("--bool-setting runtime-global surfexp-platform-boarding true"));
	assert.equal(result.actions[3].packId, "Space Age 2.1.20 - Test");
	assert.deepEqual(result.restart, ["fact1"]);
	assert.ok(result.exportNeeded);
});

test("a cluster that matches plans nothing; drift plans only the differences", () => {
	const enabled = liveWith();
	enabled.packDetails[7].mods.FluidMustFlow.enabled = true;
	assert.deepEqual(planChanges(desired, enabled, { modFile }).actions, []);
	const drift = planChanges(desired, liveWith({ controller: { "surface_export.gateway_mode": "multi" } }), { modFile });
	assert.deepEqual(drift.actions.map(action => action.argv), [
		["mod-pack", "edit", "7", "--add-mods", "FluidMustFlow:1.5.0:6c576d8d354cf930a64d79819af8f9b002583792"],
		["controller", "config", "set", "surface_export.gateway_mode", "one_gate"],
	]);
	assert.deepEqual(drift.restart, [], "controller and pack edits alone do not restart instances");
});

test("a missing or mismatched local mod blocks the plan instead of uploading the wrong bytes", () => {
	const missing = planChanges(desired, liveWith(), { modFile: name => name === "FluidMustFlow" ? { error: "FluidMustFlow_1.5.0.zip is not in docker/seed-data/mods" } : modFile(name, "0.6.12") });
	assert.match(missing.errors.join("\n"), /FluidMustFlow_1\.5\.0\.zip is not in/);
	const wrong = planChanges(desired, liveWith(), { modFile: (name, version) => ({ ...modFile(name, version), sha1: "0".repeat(40) }) });
	assert.equal(wrong.errors.length, 2);
	assert.match(wrong.errors[0], /does not match the pinned/);
});

test("apply needs --yes, resolves the new pack id after creating it, and re-plans", async () => {
	const out = { text: "", write(chunk) { this.text += chunk; } };
	const err = { text: "", write(chunk) { this.text += chunk; } };
	assert.equal(await main(["apply", "--cluster", "vm", "--desired", "d.json"], { out, err, read: () => desired, run: async () => 0 }), 2);
	assert.match(err.text, /pass --yes/);
	const state = { packs: [], created: false, calls: [], fact1Pack: undefined };
	const transport = { ctl: (...args) => {
		state.calls.push(args);
		if (args[0] === "mod-pack" && args[1] === "list") return state.created ? "id | name\n---\n9 | Space Age 2.1.20 - Test\n" : "id | name\n---\n";
		if (args[0] === "mod-pack" && args[1] === "create") { state.created = true; return ""; }
		if (args[0] === "mod-pack" && args[1] === "show") {
			return SHOW.replace("id: 7", "id: 9").replace("(disabled) FluidMustFlow", "FluidMustFlow");
		}
		if (args[0] === "mod" && args[1] === "list") return "name | version\n---\nsurfexp_gateways | 0.6.12\nFluidMustFlow | 1.5.0\n";
		if (args[0] === "controller") return 'surface_export.gateway_mode "one_gate"\n';
		if (args[0] === "instance" && args[1] === "list") return "name | status\n---\nfact1 | running\n";
		if (args[0] === "instance" && args[2] === "list") return `surface_export.debug_mode false\nfactorio.mod_pack_id ${state.fact1Pack ?? 1}\n`;
		if (args[0] === "instance" && args[2] === "set") { state.fact1Pack = Number(args[5]); return ""; }
		return "";
	} };
	const code = await main(["apply", "--cluster", "vm", "--desired", "d.json", "--yes"], { out, err, read: () => desired, run: async (_, fn) => fn(transport) });
	assert.equal(code, 0, out.text + err.text);
	assert.deepEqual(state.calls.find(call => call[2] === "set"), ["instance", "config", "set", "fact1", "factorio.mod_pack_id", "9"]);
	assert.match(out.text, /the cluster now matches the desired state/);
});
