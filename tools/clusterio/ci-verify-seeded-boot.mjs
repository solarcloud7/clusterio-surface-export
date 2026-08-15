#!/usr/bin/env node
// ci-verify-seeded-boot — did each instance boot the save docker/seed-data shipped it, or a world
// Clusterio generated because the saves directory was still empty when the instance was started?
//
// requires: docker, the surface-export-controller container running, docker/seed-data/hosts/*/*/*.zip
// produces: one PASS/FAIL/UNKNOWN line per instance; exit 0 seeded or undetermined, 40 a non-seeded
//           save is loaded
// does not: read any world, assert save CONTENT, decide readiness when the loaded save cannot be
//           determined (tools/tests/cluster-readiness.mjs stays the gate), or mutate cluster state

import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const CONTROLLER = "surface-export-controller";
export const CTL_CONFIG = "/clusterio/tokens/config-control.json";

export const EXIT_OK = 0;
export const EXIT_GENERATED_WORLD = 40;

const LIST_TIMEOUT_MS = 30_000;

export function seedExpectations(root = repoRoot) {
	const hostsDir = join(root, "docker", "seed-data", "hosts");
	const expectations = [];
	for (const host of readdirSync(hostsDir).sort()) {
		const hostDir = join(hostsDir, host);
		if (!statSync(hostDir).isDirectory()) continue;
		for (const instance of readdirSync(hostDir).sort()) {
			const instanceDir = join(hostDir, instance);
			if (!statSync(instanceDir).isDirectory()) continue;
			const seededSaves = readdirSync(instanceDir).filter(f => f.endsWith(".zip")).sort();
			if (!seededSaves.length) {
				throw new Error(`${instanceDir} ships no .zip — this check would accept any world on ${instance}`);
			}
			expectations.push({ instance, seededSaves });
		}
	}
	if (!expectations.length) {
		throw new Error(`${hostsDir} names no seeded instance — this check would accept any cluster`);
	}
	return expectations;
}

export function parseSaveList(raw) {
	const lines = String(raw).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
	const headerIndex = lines.findIndex(l => l.includes("|") && /\bname\b/.test(l) && /\bloaded\b/.test(l));
	if (headerIndex < 0) {
		return { error: `save list has no 'name'/'loaded' header row: ${lines.slice(0, 2).join(" / ").slice(0, 160)}` };
	}
	const header = lines[headerIndex].split("|").map(c => c.trim());
	const nameIndex = header.indexOf("name");
	const loadedIndex = header.indexOf("loaded");
	const loaded = [];
	for (const line of lines.slice(headerIndex + 1)) {
		if (!line.includes("|")) continue;
		const cells = line.split("|").map(c => c.trim());
		if (cells.length <= Math.max(nameIndex, loadedIndex)) continue;
		if (cells[loadedIndex] === "true" && cells[nameIndex]) loaded.push(cells[nameIndex]);
	}
	return { loaded };
}

export function decideSeededBoot(expectations, listings) {
	const results = [];
	for (const { instance, seededSaves } of expectations) {
		const listing = listings?.[instance];
		if (!listing || listing.error) {
			results.push({
				instance, verdict: "unknown",
				detail: `could not list saves (${listing?.error || "no listing was collected"}) — the readiness gate decides`,
			});
			continue;
		}
		const loaded = listing.loaded || [];
		if (loaded.length !== 1) {
			results.push({
				instance, verdict: "unknown",
				detail: `${loaded.length} save(s) report loaded=true [${loaded.join(", ")}] — the readiness gate decides`,
			});
			continue;
		}
		const [name] = loaded;
		if (seededSaves.includes(name)) {
			results.push({ instance, verdict: "seeded", detail: `booted its seeded save ${name}` });
			continue;
		}
		results.push({
			instance, verdict: "generated-world",
			detail: `booted ${name}, which docker/seed-data never shipped (expected one of [${seededSaves.join(", ")}]) — `
				+ "Clusterio generates a world only when the instance is started before its seeded save arrives",
		});
	}
	const generated = results.filter(r => r.verdict === "generated-world");
	return { ok: generated.length === 0, category: generated.length ? "generated-world" : "ok", results };
}

export function exitCodeFor(category) {
	return category === "generated-world" ? EXIT_GENERATED_WORLD : EXIT_OK;
}

export function listSaves(instances) {
	const listings = {};
	for (const instance of instances) {
		try {
			const raw = execFileSync("docker", ["exec", CONTROLLER, "npx", "clusterioctl",
				"--config", CTL_CONFIG, "--log-level", "error", "instance", "save", "list", instance],
			{ encoding: "utf8", timeout: LIST_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 });
			listings[instance] = parseSaveList(raw);
		} catch (error) {
			const message = String(error.stderr || error.message || error).split("\n").find(Boolean) || String(error);
			listings[instance] = { error: message.slice(0, 200) };
		}
	}
	return listings;
}

const LABEL = { seeded: "PASS", "generated-world": "FAIL", unknown: "UNKNOWN" };

export function runSeededBootCheck({ list = listSaves, log = console.log, expectations = null } = {}) {
	const expected = expectations || seedExpectations();
	const decision = decideSeededBoot(expected, list(expected.map(e => e.instance)));
	log(`Seeded-boot check — ${decision.results.length} instance(s)`);
	for (const r of decision.results) log(`  ${LABEL[r.verdict]}  ${r.instance} — ${r.detail}`);
	return decision;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exit(exitCodeFor(runSeededBootCheck().category));
}
