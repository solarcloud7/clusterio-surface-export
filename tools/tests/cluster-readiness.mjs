#!/usr/bin/env node
// requires: docker with the surface-export-controller and seeded host containers running; exactly two seeded hosts
//           with one instance each under docker/seed-data/hosts (source, then destination); tests/lab-gallery/manifest.json;
//           tools/shared/test-surface-prefixes.json; host logs under /clusterio/logs/host for the source-recovery refusal
// produces: one PASS/FAIL line per instance per check (including module version, source-recovery readiness and leftover
//           throwaway platforms), and a gate decision (exit 0 only when every check passes) after waiting a bounded
//           time for startup recovery that is still reconciling
// does not: verify a golden save's SHA-256, inspect fixture interiors, sample tick advance
//           (tools/clusterio/tick-liveness.mjs measures that), delete leftover platforms, or mutate any cluster state

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONTROLLER = "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";
const RCON_TIMEOUT_MS = 20_000;

import { developmentCluster } from "../shared/cluster-transport.mjs";
import { seededInstances } from "../shared/seeded-instances.mjs";
const SEEDED = seededInstances();
if (SEEDED.length !== 2 || SEEDED[0].hostNumber === SEEDED[1].hostNumber) {
	throw new Error(`cluster-readiness assigns source/destination roles to exactly two seeded hosts with one instance each; seed-data names ${SEEDED.map(r => `${r.host}/${r.instance}`).join(", ")}`);
}
export const INSTANCE_ROLES = Object.freeze([
	Object.freeze({ host: SEEDED[0].hostNumber, instance: `host-${SEEDED[0].hostNumber}`, role: "source" }),
	Object.freeze({ host: SEEDED[1].hostNumber, instance: `host-${SEEDED[1].hostNumber}`, role: "destination" }),
]);

export const CHECK_RCON = "rcon-probe";
export const CHECK_INTERFACE = "plugin-interface";
export const CHECK_SURFACES = "required-surfaces";
export const CHECK_PLATFORMS = "fixture-platforms";
export const CHECK_ROSTER = "player-roster";
export const CHECK_VERSION = "module-version";
export const CHECK_RECOVERY = "source-recovery";
export const CHECK_LEFTOVERS = "leftover-platforms";

export const RECOVERY_REFUSED = "Source recovery startup refused";
export const RECOVERY_STARTING = "Surface Export plugin initializing...";
export const CLEANUP_AUDIT = "pwsh -File tools/tests/cleanup-test-surfaces.ps1 -DryRun";
const HOST_LOG_SCAN = "for f in $(ls /clusterio/logs/host/host-*.log 2>/dev/null | tail -n 2); do "
	+ `grep -aF -e '${RECOVERY_STARTING}' -e '${RECOVERY_REFUSED}' "$f"; done | tail -n 400`;

const UBIQUITOUS_SURFACES = new Set(["nauvis"]);

const PROBE_LUA = "/sc local s={} for _,x in pairs(game.surfaces) do s[#s+1]=x.name end "
	+ "local pl={} for _,f in pairs(game.forces) do for _,p in pairs(f.platforms or {}) do "
	+ "if p.valid then pl[#pl+1]=p.name end end end "
	+ "local pr={} local ps={} for _,p in pairs(game.players) do pr[#pr+1]=p.name "
	+ "ps[#ps+1]=p.name..':'..p.surface.name..':'..p.position.x..':'..p.position.y..':'..p.controller_type end "
	+ "rcon.print(helpers.table_to_json({surfaces=s,surfaceCount=#s,platforms=pl,platformCount=#pl,"
	+ "players=pr,playerStates=ps,playerCount=#pr,tick=game.tick,iface=(remote.interfaces['surface_export']~=nil),"
	+ "ready=(storage.source_recovery_ready==true),"
	+ "version=remote.interfaces.surface_export and remote.interfaces.surface_export.get_module_version "
	+ "and remote.call('surface_export','get_module_version')}))";

export function expectedModuleVersion() {
	const text = readFileSync(join(repoRoot, "docker/seed-data/external_plugins/surface_export/module/version.lua"), "utf8");
	const match = text.match(/^return\s+"([^"]+)"/);
	if (!match) throw new Error("module/version.lua has no readable version marker");
	return match[1];
}

export function throwawayPrefixes(root = repoRoot) {
	const prefixes = JSON.parse(readFileSync(join(root, "tools", "shared", "test-surface-prefixes.json"), "utf8"));
	if (!Array.isArray(prefixes) || !prefixes.length || !prefixes.every(p => typeof p === "string" && p)) {
		throw new Error("tools/shared/test-surface-prefixes.json must be a non-empty array of name prefixes");
	}
	return prefixes;
}

export function recoveryCheck(probe) {
	if (probe?.recoveryRefusal) {
		return { ok: false, blocked: true, detail: `startup recovery refused, exports fail until repaired: ${probe.recoveryRefusal}` };
	}
	if (probe?.ready === true) return { ok: true, detail: "storage.source_recovery_ready is true" };
	return { ok: false, pending: true, detail: "storage.source_recovery_ready is not true: startup recovery is still reconciling, "
		+ `or is blocked without a refusal in the host log${probe?.recoveryLogError ? ` (host log unreadable: ${probe.recoveryLogError})` : ""}` };
}

export function latestRecoveryRefusal(lines, instanceId) {
	let latest = null;
	for (const line of lines) {
		let record;
		try { record = JSON.parse(line); }
		catch (error) {
			if (error instanceof SyntaxError) continue;
			throw error;
		}
		if (String(record?.instance_id) !== String(instanceId) || typeof record.message !== "string") continue;
		if (record.message === RECOVERY_STARTING) latest = null;
		else if (record.message.startsWith(RECOVERY_REFUSED)) latest = `${record.timestamp ?? "(no timestamp)"} ${record.message}`;
	}
	return latest;
}

export function readRecoveryRefusals(instances = INSTANCE_ROLES.map(r => r.instance), { cluster = developmentCluster } = {}) {
	const refusals = {};
	for (const instance of instances) {
		const role = INSTANCE_ROLES.find(r => r.instance === instance);
		if (!role) continue;
		try {
			const raw = cluster.docker(["exec", `surface-export-host-${role.host}`, "sh", "-c", HOST_LOG_SCAN], { timeout: RCON_TIMEOUT_MS });
			refusals[instance] = { refusal: latestRecoveryRefusal(String(raw).split(/\r?\n/), cluster.instance(role.host)) };
		} catch (error) {
			refusals[instance] = { error: String(error.stderr || error.message || error).split("\n").find(Boolean)?.slice(0, 200) ?? String(error) };
		}
	}
	return refusals;
}

export function probeReadiness(instances = INSTANCE_ROLES.map(r => r.instance), { rcon = probeCluster, logs = readRecoveryRefusals } = {}) {
	const probes = rcon(instances);
	const pending = instances.filter(instance => probes[instance] && !probes[instance].error && probes[instance].ready !== true);
	if (!pending.length) return probes;
	const refusals = logs(pending);
	for (const instance of pending) {
		const found = refusals[instance];
		if (found?.refusal) probes[instance].recoveryRefusal = found.refusal;
		else if (found?.error) probes[instance].recoveryLogError = found.error;
	}
	return probes;
}

export function evaluateRuntime(probes, expectedVersion) {
	return INSTANCE_ROLES.flatMap(({ instance }) => {
		const probe = probes[instance];
		const valid = probe && !probe.error && normalizeProbe(probe).ok;
		const runtime = { instance, checkId: "runtime", ok: Boolean(valid && probe.iface && probe.version === expectedVersion),
			detail: !valid ? `RCON unavailable: ${probe?.error ?? "invalid probe"}`
				: `Lua version ${probe.version ?? "unavailable"}; expected ${expectedVersion}` };
		return valid ? [runtime, { instance, checkId: CHECK_RECOVERY, ...recoveryCheck(probe) }] : [runtime];
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
	probe = probeReadiness, now = () => performance.now(), sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
	const deadline = now() + timeoutMs;
	let results, probes;
	do {
		probes = probe(); results = evaluateRuntime(probes, expectedVersion);
		if (results.every(r => r.ok)) return { probes, results };
		if (results.some(r => r.blocked) || now() >= deadline) break;
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
	return { ok: true, ...normalized, iface: raw.iface, tick: raw.tick, version: raw.version };
}

function missing(required, actual) {
	const present = new Set(actual);
	return required.filter(name => !present.has(name));
}

export function evaluateReadiness(expectations, probes, { expectedVersion = expectedModuleVersion(), prefixes = throwawayPrefixes() } = {}) {
	const results = [];
	const add = (instance, checkId, ok, category, detail, flags = {}) => results.push({ instance, checkId, ok, category, detail, ...flags });

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

		add(instance, CHECK_VERSION, probe.version === expectedVersion, "identity",
			`Lua module version ${probe.version ?? "unavailable"}; module/version.lua on disk is ${expectedVersion}`);

		const recovery = recoveryCheck(raw);
		add(instance, CHECK_RECOVERY, recovery.ok, "recovery", recovery.detail,
			{ ...(recovery.blocked ? { blocked: true } : {}), ...(recovery.pending ? { pending: true } : {}) });

		const leftovers = probe.platforms.filter(name => prefixes.some(prefix => String(name).startsWith(prefix)));
		add(instance, CHECK_LEFTOVERS, leftovers.length === 0, "hygiene",
			leftovers.length === 0
				? "no platform carries a throwaway test prefix"
				: `${leftovers.length} throwaway test platform(s) left by an earlier run [${leftovers.join(", ")}]; `
					+ `inspect with ${CLEANUP_AUDIT} before removing anything`);
	}

	return { ok: results.length > 0 && results.every(r => r.ok), results };
}

export function probeCluster(instances = INSTANCE_ROLES.map(r => r.instance), { target = developmentCluster.instance } = {}) {
	const probes = {};
	for (const instance of instances) {
		try {
			const role = INSTANCE_ROLES.find(r => r.instance === instance);
			const raw = execFileSync("docker", ["exec", CONTROLLER, "npx", "clusterioctl",
				"--config", CTL_CONFIG, "--log-level", "error", "instance", "send-rcon", role ? target(role.host) : instance, PROBE_LUA],
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

export async function runReadinessGate({ probe = probeReadiness, log = console.log, manifest = null,
	expectedVersion = expectedModuleVersion(), prefixes = throwawayPrefixes(), timeoutMs = 90000,
	now = () => performance.now(), sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
	const expectations = expectationsFor(manifest || loadReadinessManifest());
	const startedAt = now();
	const deadline = startedAt + timeoutMs;
	let decision;
	do {
		decision = evaluateReadiness(expectations, probe(expectations.map(e => e.instance)), { expectedVersion, prefixes });
		const failed = decision.results.filter(r => !r.ok);
		if (!failed.length || !failed.every(r => r.pending) || now() >= deadline) break;
		await sleep(Math.min(2000, Math.max(0, deadline - now())));
	} while (true);
	const durationS = ((now() - startedAt) / 1000).toFixed(1);

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
	} else process.exitCode = (await runReadinessGate()).ok ? 0 : 1;
}
