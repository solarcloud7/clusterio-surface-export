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
    example-startup-string: "first"
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
		settings: { startup: { "example-startup-string": "first" }, "runtime-global": { "surfexp-platform-boarding": true } },
	},
	controller: { "surface_export.platform_source_of_truth": "plugin_history" },
	instances: { fact1: { "surface_export.debug_mode": false } },
};
const hashes = { surfexp_gateways: "a96c8f968f260f7c6aff1880e7394bdb1853f75d", FluidMustFlow: "6c576d8d354cf930a64d79819af8f9b002583792" };
const modFile = (name, version) => ({ container: `/clusterio/seed-data/mods/${name}_${version}.zip`, sha1: hashes[name] });

function liveWith(overrides = {}) {
	return {
		packs: [{ id: 7, name: "Space Age 2.1.20 - Test" }],
		packDetails: { 7: parseModPackShow(SHOW) },
		mods: new Set(["surfexp_gateways_0.6.12", "FluidMustFlow_1.5.0"]),
		modSha1: { "surfexp_gateways_0.6.12": hashes.surfexp_gateways, "FluidMustFlow_1.5.0": hashes.FluidMustFlow },
		controller: { "surface_export.platform_source_of_truth": "plugin_history" },
		instances: { fact1: { "surface_export.debug_mode": false, "factorio.mod_pack_id": 7 } },
		...overrides,
	};
}

test("mod pack show and config list output parse into structured state", () => {
	const pack = parseModPackShow(SHOW);
	assert.equal(pack.id, 7);
	assert.equal(pack.factorioVersion, "2.1.20");
	assert.deepEqual(pack.mods.base, { version: "2.1.20", enabled: true, sha1: undefined, stored: "missing" });
	assert.deepEqual(pack.mods.FluidMustFlow, { version: "1.5.0", enabled: false, sha1: "6c576d8d354cf930a64d79819af8f9b002583792", stored: "ok" });
	assert.deepEqual(pack.settings, { startup: { "example-startup-string": "first" }, "runtime-global": { "surfexp-platform-boarding": true }, "runtime-per-user": {} });
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
	assert.ok(create.join(" ").includes("--string-setting startup example-startup-string first"));
	assert.ok(create.join(" ").includes("--bool-setting runtime-global surfexp-platform-boarding true"));
	assert.equal(result.actions[3].packId, "Space Age 2.1.20 - Test");
	assert.deepEqual(result.restart, ["fact1"]);
	assert.ok(result.exportNeeded);
});

test("a cluster that matches plans nothing; drift plans only the differences", () => {
	const enabled = liveWith();
	enabled.packDetails[7].mods.FluidMustFlow.enabled = true;
	assert.deepEqual(planChanges(desired, enabled, { modFile }).actions, []);
	const drift = planChanges(desired, liveWith({ controller: { "surface_export.platform_source_of_truth": "save_game" } }), { modFile });
	assert.deepEqual(drift.actions.map(action => action.argv), [
		["mod-pack", "edit", "7", "--add-mods", "FluidMustFlow:1.5.0:6c576d8d354cf930a64d79819af8f9b002583792"],
		["controller", "config", "set", "surface_export.platform_source_of_truth", "plugin_history"],
	]);
	assert.deepEqual(drift.restart, ["fact1"], "a content change to the pack fact1 runs needs a restart even though its pack id is unchanged");
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
		if (args[0] === "mod" && args[1] === "show") return `name: ${args[2]}\nversion: ${args[3]}\nsha1: ${hashes[args[2]]}\n`;
		if (args[0] === "controller") return 'surface_export.platform_source_of_truth "plugin_history"\n';
		if (args[0] === "instance" && args[1] === "list") return "name | status\n---\nfact1 | running\n";
		if (args[0] === "instance" && args[2] === "list") return `surface_export.debug_mode false\nfactorio.mod_pack_id ${state.fact1Pack ?? 1}\n`;
		if (args[0] === "instance" && args[2] === "set") { state.fact1Pack = Number(args[5]); return ""; }
		return "";
	} };
	const code = await main(["apply", "--cluster", "vm", "--desired", "d.json", "--yes"], { out, err, read: () => desired, run: async (_, fn) => fn(transport), modFile });
	assert.equal(code, 4, "configuration converged but the restart is still pending");
	assert.deepEqual(state.calls.find(call => call[2] === "set"), ["instance", "config", "set", "fact1", "factorio.mod_pack_id", "9"]);
	assert.match(out.text, /Configuration: converged/);
	assert.match(out.text, /Runtime: RESTART REQUIRED for fact1; the running games still use their previous configuration/);
	assert.ok(!state.calls.some(call => call[1] === "restart"), "nothing is restarted without --restart");

	state.created = false; state.fact1Pack = undefined; state.calls.length = 0; out.text = "";
	const restarted = await main(["apply", "--cluster", "vm", "--desired", "d.json", "--yes", "--restart"],
		{ out, err, read: () => desired, run: async (_, fn) => fn(transport), modFile, sleep: async () => {}, pollAttempts: 2 });
	assert.equal(restarted, 0, out.text);
	assert.deepEqual(state.calls.filter(call => call[1] === "restart"), [["instance", "restart", "fact1"]]);
	assert.match(out.text, /Runtime: restarted and running: fact1\. The loaded mods and settings were not read back/);
});

test("stored bytes that differ from the pin block the plan; a stale or missing pack pin is repaired", () => {
	const wrongStored = planChanges(desired, liveWith({ modSha1: { "surfexp_gateways_0.6.12": "b".repeat(40), "FluidMustFlow_1.5.0": hashes.FluidMustFlow } }), { modFile });
	assert.match(wrongStored.errors.join("\n"), /stores surfexp_gateways 0\.6\.12 with sha1 b{40}, but the local ZIP is a96c8f/);
	assert.ok(!wrongStored.actions.some(action => action.argv[1] === "upload"), "a stored version is never overwritten");
	const unreadable = planChanges(desired, liveWith({ modSha1: {} }), { modFile });
	assert.match(unreadable.errors.join("\n"), /could not read the stored sha1/);
	const unpinned = liveWith();
	unpinned.packDetails[7].mods.FluidMustFlow.enabled = true;
	delete unpinned.packDetails[7].mods.surfexp_gateways.sha1;
	const repin = planChanges(desired, unpinned, { modFile });
	assert.deepEqual(repin.actions.map(action => action.argv), [["mod-pack", "edit", "7", "--add-mods", "surfexp_gateways:0.6.12:a96c8f968f260f7c6aff1880e7394bdb1853f75d"]]);
	assert.deepEqual(repin.restart, ["fact1"]);
	const flagged = parseModPackShow(SHOW.replace("  surfexp_gateways 0.6.12", "  ! surfexp_gateways 0.6.12"));
	assert.equal(flagged.mods.surfexp_gateways.stored, "checksum-mismatch");
});

test("a startup-setting change on an assigned pack restarts only the instances on that pack", () => {
	const live = liveWith({ instances: { fact1: { "surface_export.debug_mode": false, "factorio.mod_pack_id": 7 }, fact2: { "factorio.mod_pack_id": 3 } } });
	live.packDetails[7].mods.FluidMustFlow.enabled = true;
	live.packDetails[7].settings.startup["example-startup-string"] = "second";
	const result = planChanges({ ...desired, instances: { fact1: {}, fact2: {} }, instanceModPack: false }, live, { modFile });
	assert.deepEqual(result.actions.map(action => action.argv.slice(0, 3)), [["mod-pack", "edit", "7"]]);
	assert.deepEqual(result.restart, ["fact1"]);
});

test("host config is planned by name and only where it differs", () => {
	const withHosts = { ...desired, hosts: { "clusterio-host-1": { "host.public_address": "fact1.example" } } };
	const enabled = liveWith({ hosts: { "clusterio-host-1": { "host.public_address": "localhost" } } });
	enabled.packDetails[7].mods.FluidMustFlow.enabled = true;
	const result = planChanges(withHosts, enabled, { modFile });
	assert.deepEqual(result.errors, []);
	assert.deepEqual(result.actions.map(action => action.argv), [
		["host", "config", "set", "clusterio-host-1", "host.public_address", "fact1.example"],
	]);
	const missing = planChanges(withHosts, liveWith({ hosts: {} }), { modFile });
	assert.match(missing.errors.join("\n"), /host clusterio-host-1 is not connected/);
});

test("a desired state that still sets gateway links is blocked, and no link command is planned", () => {
	const enabled = liveWith();
	enabled.packDetails[7].mods.FluidMustFlow.enabled = true;
	const result = planChanges({ ...desired, gatewayLinks: { fact1: { surfexp_gateway_hub: ["fact2"] } } }, enabled, { modFile });
	assert.match(result.errors.join("\n"), /gatewayLinks is no longer supported: every server reaches every other server/);
	assert.equal(result.actions.some(action => action.argv.includes("set-gateway-links")), false);
});

test("restart-only controller fields restart instances, empty values block, and colour settings stay structured", () => {
	const enabled = () => { const live = liveWith(); live.packDetails[7].mods.FluidMustFlow.enabled = true; return live; };
	const policy = planChanges({ ...desired, controller: { "surface_export.platform_source_of_truth": "save_game" } }, enabled(), { modFile });
	assert.deepEqual(policy.restart, ["fact1"], "the platform source of truth applies only after a restart");
	const empty = planChanges({ ...desired, instances: { fact1: { "surface_export.disabled_planets": "" } } }, enabled(), { modFile });
	assert.match(empty.errors.join("\n"), /fact1 surface_export\.disabled_planets: an empty value cannot be set through clusterioctl/);
	const colour = { r: 1, g: 0.5, b: 0, a: 1 };
	const live = enabled();
	live.packDetails[7].settings.startup.tint = { ...colour };
	const same = planChanges({ ...desired, modPack: { ...desired.modPack, settings: { ...desired.modPack.settings, startup: { ...desired.modPack.settings.startup, tint: colour } } } }, live, { modFile });
	assert.deepEqual(same.actions, [], "an equal colour object is not re-applied forever");
	live.packDetails[7].settings.startup.tint = { r: 0, g: 0, b: 0, a: 1 };
	const changed = planChanges({ ...desired, modPack: { ...desired.modPack, settings: { startup: { ...desired.modPack.settings.startup, tint: colour } } } }, live, { modFile });
	assert.ok(changed.actions[0].argv.join(" ").includes(`--color-setting startup tint ${JSON.stringify(colour)}`));
});

test("portal colours are assigned by the controller; server destinations in a desired file are refused", () => {
	const live = () => {
		const state = liveWith({ instanceIds: { fact1: 11, fact2: 22 } });
		state.packDetails[7].mods.FluidMustFlow.enabled = true;
		return state;
	};
	const named = planChanges({ ...structuredClone(desired), serverDestinations: { fact1: "Forge" } }, live(), { modFile });
	assert.match(named.errors.join("; "), /serverDestinations is no longer supported: the controller gives each server one of the four portal colours/);
	assert.equal(named.actions.some(action => action.argv.includes("surfexp-gateway-instances")), false);
	const raw = structuredClone(desired);
	raw.modPack.settings.startup["surfexp-gateway-instances"] = "11=Forge";
	assert.match(planChanges(raw, live(), { modFile }).errors.join("; "), /no longer has the surfexp-gateway-instances setting/);
	const stale = live();
	stale.packDetails[7].settings.startup["surfexp-gateway-instances"] = "fact1=Forge";
	assert.deepEqual(planChanges(structuredClone(desired), stale, { modFile }).errors, [],
		"a value left on the live pack by an older mod is ignored, not a reason to block the plan");
});

test("the removed gateway layout setting and controller gateway mode are refused, and neither is set", () => {
	const live = () => {
		const state = liveWith();
		state.packDetails[7].mods.FluidMustFlow.enabled = true;
		return state;
	};
	const layout = structuredClone(desired);
	layout.modPack.settings.startup["surfexp-gateway-layout"] = "one_gate";
	const layoutPlan = planChanges(layout, live(), { modFile });
	assert.match(layoutPlan.errors.join("; "), /the gateway mod no longer has the surfexp-gateway-layout setting: there is one gateway layout/);
	const mode = planChanges({ ...structuredClone(desired), controller: { "surface_export.gateway_mode": "one_gate" } }, live(), { modFile });
	assert.match(mode.errors.join("; "), /surface_export\.gateway_mode is no longer a controller setting/);
	assert.equal(mode.actions.some(action => action.argv.includes("surface_export.gateway_mode")), false);
	const stale = live();
	stale.packDetails[7].settings.startup["surfexp-gateway-layout"] = "multi";
	stale.controller["surface_export.gateway_mode"] = "multi";
	assert.deepEqual(planChanges(structuredClone(desired), stale, { modFile }).errors, [],
		"values left on the live cluster by an older version are ignored, not a reason to block the plan");
});
