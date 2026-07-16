import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { certifyAttributionFixture, certifyReplayFixture } from "./fixture-contract.mjs";
import {
	assertDeterministicObservations,
	assertExactConstruction,
	buildDupTopology,
	certifyGeometryControls,
	constructionDescriptors,
	maximumLineNodes,
	projectDetailedContentReads,
} from "./dup-topology.mjs";
import { RuntimeClient } from "./runtime-client.mjs";

const MAX_CHUNK = 25;

export function assertIdlePreflight(state) {
	for (const field of ["gamePaused", "surfaces", "labStorage", "jobs", "locks", "holds", "tombstones"]) {
		if (state?.[field]) throw new Error(`preflight blocked by ${field}: ${JSON.stringify(state)}`);
	}
	return state;
}

export function assertZeroLeftovers(state) {
	for (const field of ["gamePaused", "surfaces", "surfaceItems", "groundItems", "labStorage", "jobs", "locks", "holds", "tombstones"]) {
		if (state?.[field]) throw new Error(`cleanup left ${field}: ${JSON.stringify(state)}`);
	}
	return state;
}

export function parseArguments(argv) {
	const result = { rung: null, injectFailure: false, dryRun: false };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--rung") result.rung = argv[++index];
		else if (argument === "--inject-failure") result.injectFailure = true;
		else if (argument === "--dry-run") result.dryRun = true;
		else throw new Error(`unknown argument ${argument}`);
	}
	if (result.rung !== "r0") throw new Error("this runner supports only r0");
	return result;
}

export function chunkEntities(entities) {
	const chunks = [];
	for (let index = 0; index < entities.length; index += MAX_CHUNK) chunks.push(entities.slice(index, index + MAX_CHUNK));
	return chunks;
}

function profilerMs(value) {
	const match = /Duration:\s*([0-9.]+)ms/.exec(String(value || ""));
	return match ? Number(match[1]) : null;
}

function summarizePhase(chunks = []) {
	const times = chunks.flatMap(chunk => [profilerMs(chunk.operation?.profiler), profilerMs(chunk.heartbeat?.profiler)]).filter(Number.isFinite);
	return {
		chunks: chunks.length,
		rows: chunks.reduce((total, chunk) => total + Number(chunk.rows || 0), 0),
		maximumProfilerMs: times.length ? Math.max(...times) : null,
		lastHeartbeat: chunks.at(-1)?.heartbeat || null,
	};
}

export function summarizeBoundary(evidence = {}) {
	return {
		prepare: summarizePhase(evidence.telemetry?.prepare),
		construct: summarizePhase(evidence.telemetry?.construct),
		cleanup: (evidence.cleanupResults || []).map(row => ({ success: row.success, deleted: row.deleted, gamePaused: row.gamePaused, profiler: row.profiler })),
		finalInspections: (evidence.finalInspections || []).map(row => ({
			success: row.success, version: row.version, gamePaused: row.gamePaused, surfaces: row.surfaces,
			surfaceItems: row.surfaceItems, groundItems: row.groundItems, labStorage: row.labStorage,
			jobs: row.jobs, locks: row.locks, holds: row.holds, tombstones: row.tombstones, profiler: row.profiler,
		})),
	};
}

export function dockerTransport(instance) {
	const runtime = readFileSync(new URL("./lab-runtime.lua", import.meta.url), "utf8");
	return async (operation, payload = {}) => {
		const json = JSON.stringify({ operation, ...payload });
		if (json.includes("]=]")) throw new Error("request contains an unsafe Lua long-string delimiter");
		const command = `/c local request=helpers.json_to_table([=[${json}]=]); local ok,result=pcall(function() ${runtime} end); if ok then local profiler=result.profiler;result.profiler=nil;if profiler then rcon.print(profiler) end;rcon.print(helpers.table_to_json(result)) else rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) end`;
		const output = execFileSync("docker", ["exec", "surface-export-controller", "npx", "clusterioctl", "--log-level", "error", "instance", "send-rcon", String(instance), command, "--config", "/clusterio/tokens/config-control.json"], { encoding: "utf8", timeout: 180_000 });
		const lines = output.trim().split(/\r?\n/).filter(Boolean);
		const result = JSON.parse(lines.at(-1));
		if (result.success === true && lines.length > 1) result.profiler = lines.at(-2);
		return result;
	};
}

export async function prepareAll(client, surfaceName, descriptors) {
	const telemetry = [];
	for (const entities of chunkEntities(descriptors)) {
		const operation = await client.call("prepare_terrain", { surfaceName, entities });
		const heartbeat = await client.call("heartbeat");
		telemetry.push({ rows: entities.length, projectedReads: 0, operation, heartbeat });
	}
	return telemetry;
}

export async function constructAll(client, surfaceName, descriptors) {
	const telemetry = [];
	for (const entities of chunkEntities(descriptors)) {
		const operation = await client.call("construct", { surfaceName, entities });
		const heartbeat = await client.call("heartbeat");
		telemetry.push({ rows: entities.length, projectedReads: 0, operation, heartbeat });
	}
	return telemetry;
}

export async function cleanupBoth(clients) {
	const results = [];
	for (const client of clients) {
		try { results.push(await client.call("cleanup")); }
		catch (error) { results.push({ success: false, error: error.message }); }
	}
	return results;
}

export async function executeR0({ clients, descriptors, surfaceName, injectFailure = false, evidence = {} }) {
	for (const client of clients) assertIdlePreflight(await client.call("inspect"));
	try {
		for (const client of clients) await client.beginOwnedPause();
		const prepareTelemetry = await prepareAll(clients[0], surfaceName, descriptors);
		const constructTelemetry = await constructAll(clients[0], surfaceName, descriptors);
		evidence.telemetry = { prepare: prepareTelemetry, construct: constructTelemetry };
		if (injectFailure) throw new Error("injected post-construction failure");
		const observations = [];
		for (let run = 0; run < 3; run += 1) observations.push(await clients[0].call("observe_graph"));
		return { observations, telemetry: { prepare: prepareTelemetry, construct: constructTelemetry } };
	} finally {
		const cleanupResults = await cleanupBoth(clients);
		evidence.cleanupResults = cleanupResults;
		const boundaryErrors = cleanupResults.filter(result => result.success !== true)
			.map(result => new Error(`cleanup failed: ${result.error || "missing success=true"}`));
		for (const client of clients) {
			try { await client.endOwnedPause(); }
			catch (error) { boundaryErrors.push(error); }
		}
		evidence.finalInspections = [];
		for (const client of clients) {
			try {
				const inspection = await client.call("inspect");
				evidence.finalInspections.push(inspection);
				assertZeroLeftovers(inspection);
			}
			catch (error) { boundaryErrors.push(error); }
		}
		if (boundaryErrors.length) throw new AggregateError(boundaryErrors, "ADJ-R0 cleanup boundary failed");
	}
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	const replayRaw = readFileSync(new URL("../fixtures/replay_payload_DUP-233855.json", import.meta.url));
	const replay = JSON.parse(replayRaw);
	const attribution = JSON.parse(readFileSync(new URL("../fixtures/dup-233855-loss-attribution.json", import.meta.url), "utf8"));
	const fixture = certifyReplayFixture(replayRaw);
	const endpoints = certifyAttributionFixture(attribution).endpointKeys;
	const descriptors = constructionDescriptors(replay);
	const projectedReads = projectDetailedContentReads({
		observationRuns: 3,
		maximumLineNodes: maximumLineNodes(replay),
	});
	const result = { rung: "ADJ-R0", fixture, endpoints, projectedReads, dryRun: options.dryRun, started: new Date().toISOString() };
	let stopped = false;
	try {
	if (!options.dryRun) {
		const clients = [
			new RuntimeClient({ transport: dockerTransport("clusterio-host-2-instance-1") }),
			new RuntimeClient({ transport: dockerTransport("clusterio-host-1-instance-1") }),
		];
		let injectedStopped = false;
		const injectedFailureBoundary = {};
		try {
			await executeR0({ clients, descriptors, surfaceName: `belt-adjacency-r0-injected-${Date.now()}`, injectFailure: true, evidence: injectedFailureBoundary });
		} catch (error) {
			if (!/injected post-construction failure/.test(error.message)) throw error;
			injectedStopped = true;
		}
		if (!injectedStopped) throw new Error("cleanup rehearsal did not reach its injected failure");
		result.injectedFailureBoundary = summarizeBoundary(injectedFailureBoundary);
		if (options.injectFailure) {
			result.injectedFailureOnly = true;
			result.status = "INJECTED_FAILURE_CLEANUP_PROVEN";
		} else {
			const liveBoundary = {};
			const live = await executeR0({ clients, descriptors, surfaceName: `belt-adjacency-r0-live-${Date.now()}`, evidence: liveBoundary });
			const observations = live.observations;
			result.liveBoundary = summarizeBoundary(liveBoundary);
			result.determinism = assertDeterministicObservations(observations);
			assertExactConstruction(descriptors, observations[0].entities);
			if (observations.some(row => row.surfaceItems !== 0 || row.groundItems !== 0)) throw new Error("empty target contains items");
			result.geometryControls = certifyGeometryControls(observations[0]);
			const topology = buildDupTopology(observations[0], endpoints);
			const reasonKinds = {};
			for (const reason of topology.graph.reasons) {
				const kind = reason.startsWith("geometry disagreement") ? "geometry disagreement"
					: reason.startsWith("ambiguous transition") ? "ambiguous transition"
						: reason.startsWith("missing geometry transition") ? "missing geometry transition" : "other";
				reasonKinds[kind] = (reasonKinds[kind] || 0) + 1;
			}
			result.graph = {
				supported: topology.graph.supported,
				signature: topology.graph.signature,
				reasonCount: topology.graph.reasons.length,
				reasonKinds,
				reasonExamples: topology.graph.reasons.slice(0, 20),
				unsupportedNetworks: topology.graph.unsupportedNetworks,
				nodes: topology.graph.nodes.length,
				edges: topology.graph.edges.length,
			};
			result.knownEndpoints = topology.knownEndpoints;
			if (!topology.graph.supported || topology.knownEndpoints.some(row => row.legalRegion.length === 0)) {
				throw new Error(`ADJ-R0 topology unsupported: ${JSON.stringify(result.graph)}`);
			}
			result.status = "PASS";
		}
	} else result.status = "DRY_RUN";
	} catch (error) {
		stopped = true;
		result.status = "STOP";
		result.schedulerRestoration = "NOT TESTED";
		result.error = error.stack || error.message;
		if (error.details) result.stopDetails = error.details;
	}
	result.finished = new Date().toISOString();
	const output = JSON.stringify(result, null, 2);
	writeFileSync(new URL("../results/adjacency-r0-2.0.77.json", import.meta.url), `${output}\n`);
	console.log(output);
	if (stopped) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(error => { console.error(error); process.exitCode = 1; });
}
