#!/usr/bin/env node
// requires: docker with the surface-export-controller container running; tests/lab-gallery/manifest.json
// produces: one PASS/FAIL line per instance per check, and a gate decision (exit 0 only when every check passes)
// does not: verify a golden save's SHA-256, inspect fixture interiors, sample tick advance
//           (tools/clusterio/tick-liveness.mjs measures that), or mutate any cluster state

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONTROLLER = "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";
const RCON_TIMEOUT_MS = 20_000;

import { seededInstanceNames } from "../shared/seeded-instances.mjs";
const SEEDED = seededInstanceNames();
if (SEEDED.length !== 2) {
	throw new Error(`cluster-readiness assigns source/destination roles to exactly two seeded instances; seed-data names ${SEEDED.length}: ${SEEDED.join(", ")}`);
}
export const INSTANCE_ROLES = Object.freeze([
	Object.freeze({ instance: SEEDED[0], role: "source" }),
	Object.freeze({ instance: SEEDED[1], role: "destination" }),
]);

export const CHECK_RCON = "rcon-probe";
export const CHECK_INTERFACE = "plugin-interface";
export const CHECK_SURFACES = "required-surfaces";
export const CHECK_PLATFORMS = "fixture-platforms";
export const CHECK_ROSTER = "player-roster";

const UBIQUITOUS_SURFACES = new Set(["nauvis"]);

const PROBE_LUA = "/sc local s={} for _,x in pairs(game.surfaces) do s[#s+1]=x.name end "
	+ "local pl={} for _,f in pairs(game.forces) do for _,p in pairs(f.platforms or {}) do "
	+ "if p.valid then pl[#pl+1]=p.name end end end "
	+ "local pr={} local ps={} for _,p in pairs(game.players) do pr[#pr+1]=p.name "
	+ "ps[#ps+1]=p.name..':'..p.surface.name..':'..p.position.x..':'..p.position.y..':'..p.controller_type end "
	+ "rcon.print(helpers.table_to_json({surfaces=s,surfaceCount=#s,platforms=pl,platformCount=#pl,"
	+ "players=pr,playerStates=ps,playerCount=#pr,tick=game.tick,iface=(remote.interfaces['surface_export']~=nil),"
	+ "version=remote.interfaces.surface_export and remote.interfaces.surface_export.get_module_version "
	+ "and remote.call('surface_export','get_module_version')}))";

export function expectedModuleVersion() {
	const text = readFileSync(join(repoRoot, "docker/seed-data/external_plugins/surface_export/module/version.lua"), "utf8");
	const match = text.match(/^return\s+"([^"]+)"/);
	if (!match) throw new Error("module/version.lua has no readable version marker");
	return match[1];
}

export function evaluateRuntime(probes, expectedVersion) {
	return INSTANCE_ROLES.flatMap(({ instance }) => {
		const probe = probes[instance];
		const valid = probe && !probe.error && normalizeProbe(probe).ok;
		return [{ instance, checkId: "runtime", ok: Boolean(valid && probe.iface && probe.version === expectedVersion),
			detail: !valid ? `RCON unavailable: ${probe?.error ?? "invalid probe"}`
				: `Lua version ${probe.version ?? "unavailable"}; expected ${expectedVersion}` }];
	});
}

export function compareWorlds(before, after) {
	const changes = [];
	for (const { instance } of INSTANCE_ROLES) {
		for (const key of ["surfaces", "platforms", "players", "playerStates"]) {
			const old = toList(before[instance]?.[key]).sort();
			const current = toList(after[instance]?.[key]).sort();
			if (JSON.stringify(old) !== JSON.stringify(current)) changes.push(`${instance}/${key} changed during reload`);
		}
	}
	return changes;
}

export async function waitForRuntime({ timeoutMs = 90000, expectedVersion = expectedModuleVersion(),
	probe = probeCluster, now = () => performance.now(), sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
	const deadline = now() + timeoutMs;
	let results, probes;
	do {
		probes = probe(); results = evaluateRuntime(probes, expectedVersion);
		if (results.every(r => r.ok)) return { probes, results };
		if (now() >= deadline) break;
		await sleep(Math.min(1000, Math.max(0, deadline - now())));
	} while (true);
	throw new Error(`Runtime readiness failed: ${results.filter(r => !r.ok).map(r => `${r.instance}: ${r.detail}`).join("; ")}`);
}

export function toList(value) {
	if (Array.isArray(value)) return value;
	if (value && typeof value === "object") return Object.values(value);
	return [];
}

export function loadReadinessManifest(root = repoRoot) {
	return JSON.parse(readFileSync(join(root, "tests", "lab-gallery", "manifest.json"), "utf8"));
}

export function expectationsFor(manifest) {
	return INSTANCE_ROLES.map(({ instance, role }) => {
		const save = manifest?.saves?.[role];
		const requiredSurfaces = (save?.expectedCensus?.surfaces || []).map(s => s?.name).filter(Boolean);
		const requiredPlatforms = [...new Set((manifest?.fixtures || [])
			.filter(f => f?.saveRole === role)
			.map(f => f?.platformName)
			.filter(Boolean))].sort();
		if (!requiredSurfaces.length) {
			throw new Error(`gallery manifest names no expected surfaces for the ${role} save — `
				+ `the ${CHECK_SURFACES} check would accept any world`);
		}
		if (!requiredSurfaces.some(name => !UBIQUITOUS_SURFACES.has(name))) {
			throw new Error(`gallery manifest names only ubiquitous surfaces (${requiredSurfaces.join(", ")}) for the `
				+ `${role} save — the ${CHECK_SURFACES} check would accept a freshly generated world`);
		}
		return { instance, role, requiredSurfaces, requiredPlatforms };
	});
}

export function normalizeProbe(raw) {
	if (!raw || typeof raw !== "object") {
		return { ok: false, detail: `probe reply was not a JSON object: ${JSON.stringify(raw)}` };
	}
	const normalized = {};
	for (const [listKey, countKey] of [["surfaces", "surfaceCount"], ["platforms", "platformCount"], ["players", "playerCount"]]) {
		const list = toList(raw[listKey]);
		const count = raw[countKey];
		if (!Number.isInteger(count)) {
			return { ok: false, detail: `probe reply has no integer ${countKey} (got ${JSON.stringify(count)})` };
		}
		if (list.length !== count) {
			return { ok: false, detail: `probe reply ${listKey} carries ${list.length} entries but ${countKey}=${count}` };
		}
		normalized[listKey] = list;
	}
	if (typeof raw.iface !== "boolean") {
		return { ok: false, detail: `probe reply has no boolean iface (got ${JSON.stringify(raw.iface)})` };
	}
	return { ok: true, ...normalized, iface: raw.iface, tick: raw.tick };
}

function missing(required, actual) {
	const present = new Set(actual);
	return required.filter(name => !present.has(name));
}

export function evaluateReadiness(expectations, probes) {
	const results = [];
	const add = (instance, checkId, ok, category, detail) => results.push({ instance, checkId, ok, category, detail });

	for (const { instance, role, requiredSurfaces, requiredPlatforms } of expectations) {
		const raw = probes?.[instance];
		if (raw === undefined) {
			add(instance, CHECK_RCON, false, "probe-error", "no probe result was collected for this instance");
			continue;
		}
		if (raw.error) {
			add(instance, CHECK_RCON, false, "probe-error", `RCON probe failed: ${raw.error}`);
			continue;
		}
		const probe = normalizeProbe(raw);
		if (!probe.ok) {
			add(instance, CHECK_RCON, false, "probe-error", probe.detail);
			continue;
		}
		add(instance, CHECK_RCON, true, "probe-error", `answered RCON at tick ${probe.tick}`);

		add(instance, CHECK_INTERFACE, probe.iface, "identity",
			probe.iface ? "remote.interfaces['surface_export'] is present"
				: "remote.interfaces['surface_export'] is absent — the save-patched module did not load");

		const missingSurfaces = missing(requiredSurfaces, probe.surfaces);
		add(instance, CHECK_SURFACES, missingSurfaces.length === 0, "identity",
			missingSurfaces.length === 0
				? `all ${requiredSurfaces.length} ${role}-save surface(s) present [${probe.surfaces.join(", ")}]`
				: `${role} save is missing surface(s) [${missingSurfaces.join(", ")}] — found [${probe.surfaces.join(", ")}]`);

		if (requiredPlatforms.length) {
			const missingPlatforms = missing(requiredPlatforms, probe.platforms);
			add(instance, CHECK_PLATFORMS, missingPlatforms.length === 0, "identity",
				missingPlatforms.length === 0
					? `all ${requiredPlatforms.length} fixture platform(s) present [${probe.platforms.join(", ")}]`
					: `missing fixture platform(s) [${missingPlatforms.join(", ")}] — found [${probe.platforms.join(", ")}]`);
		}

		add(instance, CHECK_ROSTER, probe.players.length > 0, "identity",
			probe.players.length > 0
				? `${probe.players.length} player(s) in game.players [${probe.players.join(", ")}]`
				: "game.players is empty — a seeded golden save carries its banked roster, a freshly generated world does not");
	}

	return { ok: results.length > 0 && results.every(r => r.ok), results };
}

export function probeCluster(instances = INSTANCE_ROLES.map(r => r.instance)) {
	const probes = {};
	for (const instance of instances) {
		try {
			const raw = execFileSync("docker", ["exec", CONTROLLER, "npx", "clusterioctl",
				"--config", CTL_CONFIG, "--log-level", "error", "instance", "send-rcon", instance, PROBE_LUA],
			{ encoding: "utf8", timeout: RCON_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 }).trim();
			const line = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean).at(-1) || "";
			try {
				probes[instance] = JSON.parse(line);
			} catch (error) {
				probes[instance] = { error: `unparseable RCON reply (${error.message}): ${line.slice(0, 160)}` };
			}
		} catch (error) {
			const message = String(error.stderr || error.message || error).split("\n").find(Boolean) || String(error);
			probes[instance] = { error: message.slice(0, 200) };
		}
	}
	return probes;
}

export function runReadinessGate({ probe = probeCluster, log = console.log, manifest = null } = {}) {
	const expectations = expectationsFor(manifest || loadReadinessManifest());
	const startedAt = Date.now();
	const probes = probe(expectations.map(e => e.instance));
	const decision = evaluateReadiness(expectations, probes);
	const durationS = ((Date.now() - startedAt) / 1000).toFixed(1);

	log(`Cluster readiness preflight — ${decision.results.length} check(s) across ${expectations.length} instance(s) (${durationS}s)`);
	for (const r of decision.results) {
		log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.instance}  ${r.checkId} — ${r.detail}`);
	}
	if (!decision.ok) {
		const failed = decision.results.filter(r => !r.ok);
		log(`  ${failed.length} check(s) FAILED: ${failed.map(r => `${r.instance}/${r.checkId}`).join(", ")}`);
	}
	return decision;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	if (process.argv.includes("--runtime")) {
		const value = flag => process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : null;
		try {
			const captured = process.argv.includes("--capture-world") ? probeCluster() : null;
			if (captured && INSTANCE_ROLES.some(({ instance }) => !normalizeProbe(captured[instance]).ok || !captured[instance].iface)) {
				throw new Error("Cannot capture world: both existing instances must answer RCON with the plugin loaded");
			}
			const { probes, results } = captured ? { probes: captured, results: [] } : await waitForRuntime();
			if (value("--compare")) {
				const changes = compareWorlds(JSON.parse(readFileSync(value("--compare"), "utf8")), probes);
				if (changes.length) throw new Error(changes.join("; "));
			}
			if (value("--snapshot")) writeFileSync(value("--snapshot"), JSON.stringify(probes, null, 2) + "\n", "utf8");
			for (const result of results) console.log(`PASS ${result.instance}: ${result.detail}`);
		} catch (error) { console.error(error.message); process.exitCode = 1; }
	} else process.exitCode = runReadinessGate().ok ? 0 : 1;
}
