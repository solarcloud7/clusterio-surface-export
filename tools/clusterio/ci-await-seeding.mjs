#!/usr/bin/env node
// ci-await-seeding — block until the controller entrypoint's seeding pass has finished.
//
// requires: docker, the surface-export-controller container running
// produces: one poll line per attempt and one terminal line; exit 0 seeded, 4 timeout, 5 probe error
// does not: create/assign/start any instance, assert that seeding SUCCEEDED, inspect any world
//           (tools/tests/cluster-readiness.mjs measures that), or mutate cluster state

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const CONTROLLER = "surface-export-controller";
export const SEED_MARKER = "/clusterio/data/.seed-complete";
export const PRESENT = "seed-complete-present";
export const ABSENT = "seed-complete-absent";

export const EXIT_SEEDED = 0;
export const EXIT_TIMEOUT = 4;
export const EXIT_PROBE_ERROR = 5;

// 2 instances x the seed's own 120s per-instance start budget (seed-instances.sh), plus headroom
// over the ~60-75s this phase measured in runs 31903406947 and 31893741832.
export const DEFAULT_TIMEOUT_MS = 360_000;
export const POLL_INTERVAL_MS = 4_000;
const PROBE_TIMEOUT_MS = 20_000;

export function decideSeedWait({ probe, elapsedMs, timeoutMs }) {
	const waitedS = (elapsedMs / 1000).toFixed(0);
	if (probe?.error) {
		return { status: "probe-error", detail: `could not read ${SEED_MARKER} on ${CONTROLLER}: ${probe.error}` };
	}
	if (probe?.token === PRESENT) {
		return { status: "seeded", detail: `${SEED_MARKER} observed after ${waitedS}s — controller seeding has finished` };
	}
	if (probe?.token !== ABSENT) {
		return {
			status: "probe-error",
			detail: `${CONTROLLER} answered with neither ${PRESENT} nor ${ABSENT} (got ${JSON.stringify(probe?.token)})`,
		};
	}
	if (elapsedMs >= timeoutMs) {
		return {
			status: "timeout",
			detail: `${SEED_MARKER} never appeared within ${(timeoutMs / 1000).toFixed(0)}s — the controller never `
				+ "finished seeding, so no instance has its golden save yet",
		};
	}
	return { status: "waiting", detail: `still seeding after ${waitedS}s (${SEED_MARKER} absent)` };
}

export function exitCodeFor(status) {
	if (status === "seeded") return EXIT_SEEDED;
	if (status === "timeout") return EXIT_TIMEOUT;
	return EXIT_PROBE_ERROR;
}

export function probeSeedMarker() {
	try {
		const raw = execFileSync("docker", ["exec", CONTROLLER, "sh", "-c",
			`test -f ${SEED_MARKER} && echo ${PRESENT} || echo ${ABSENT}`],
		{ encoding: "utf8", timeout: PROBE_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
		const token = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean).at(-1) || "";
		return { token };
	} catch (error) {
		const message = String(error.stderr || error.message || error).split("\n").find(Boolean) || String(error);
		return { error: message.slice(0, 200) };
	}
}

const wait = ms => new Promise(resolve => { setTimeout(resolve, ms); });

export async function awaitSeeding({
	probe = probeSeedMarker,
	log = console.log,
	sleep = wait,
	now = Date.now,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	pollIntervalMs = POLL_INTERVAL_MS,
} = {}) {
	const startedAt = now();
	log(`Waiting for ${SEED_MARKER} on ${CONTROLLER} (up to ${(timeoutMs / 1000).toFixed(0)}s)...`);
	for (;;) {
		const decision = decideSeedWait({ probe: probe(), elapsedMs: now() - startedAt, timeoutMs });
		log(`  ${decision.detail}`);
		if (decision.status !== "waiting") return decision;
		await sleep(pollIntervalMs);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const argv = process.argv.slice(2);
	const flag = name => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null; };
	const timeoutS = Number(flag("--timeout-s"));
	const decision = await awaitSeeding({
		timeoutMs: Number.isFinite(timeoutS) && timeoutS > 0 ? timeoutS * 1000 : DEFAULT_TIMEOUT_MS,
	});
	process.exit(exitCodeFor(decision.status));
}
