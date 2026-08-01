// log-query.mjs — the I/O half of `testkit log`: fetch a transaction-log entry or a debug dump, and
// answer a dotted-path query against it through the oracle.
//
// Every outcome that is NOT a resolved value is an operational error (exit 2). There is deliberately
// no exit 1 anywhere in this file: exit 1 in this CLI means "a finding about the repo", and a
// transaction log is not a payload — a path that does not resolve is a wrong path or a
// schema-version fact, never a data-loss claim. Conflating the two is the original incident.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { exitCodeFor, resolvePath } from "./path-oracle.mjs";

const PATHS = JSON.parse(readFileSync(
	fileURLToPath(new URL("../../shared/cluster-paths.json", import.meta.url)), "utf8"));

export const STORE = PATHS.transactionLogStore;

/** Raise the error to something a caller can act on, keeping the original stderr verbatim. */
function dockerRead(args, { what }) {
	try {
		// argv, NOT `sh -c`: no shell means no chance of reintroducing the `2>&1` that corrupts the
		// JSON, and execFileSync keeps stderr on its own pipe. 256 MB because the store carries full
		// per-transfer item-count maps.
		return execFileSync("docker", args, {
			encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 256 * 1024 * 1024,
		});
	} catch (error) {
		const stderr = String(error.stderr || "").trim();
		if (/No such container/i.test(stderr)) {
			throw new Error(`${what}: container ${STORE.container} is not running.\n${stderr}`);
		}
		if (/No such file or directory/i.test(stderr)) {
			throw new Error(`${what}: the file does not exist yet. This is NOT evidence that a value is `
				+ `absent — it means nothing has written here.\n${stderr}`);
		}
		throw new Error(`${what}: docker read failed (exit ${error.status ?? "?"}).\n${stderr || error.message}`);
	}
}

/** The controller's transaction-log store, as an array. Throws with a diagnosis on any failure. */
export function readTransactionLogStore() {
	const raw = dockerRead(["exec", STORE.container, "cat", STORE.path],
		{ what: `reading ${STORE.container}:${STORE.path}` });
	return parseStore(raw, `${STORE.container}:${STORE.path}`);
}

/** Same store, from a file captured earlier — makes the CLI testable with no cluster. */
export function readStoreFile(file) {
	let raw;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		throw new Error(`reading ${file}: ${error.message}`);
	}
	return parseStore(raw, file);
}

function parseStore(raw, source) {
	const trimmed = raw.trim();
	if (!trimmed) return [];   // an empty store is a real measurement: zero entries, not an error
	let parsed;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		throw new Error(`${source} is not valid JSON (${error.message}). First 400 chars:\n`
			+ `${trimmed.slice(0, 400)}`);
	}
	if (!Array.isArray(parsed)) {
		throw new Error(`${source} parsed to ${typeof parsed}, expected an array of transaction logs`);
	}
	return parsed;
}

/**
 * Pick an entry. `latest` is the LAST element, matching how get-transaction-log.ps1 reads it — with a
 * warning when array order and savedAt disagree, because "a correct-looking value from the wrong
 * record" is exactly the failure mode this command exists to prevent.
 */
export function selectEntry(store, selector) {
	if (!store.length) {
		throw new Error(`the transaction-log store is empty — no entry to query. Run a transfer first.`);
	}
	if (selector === "latest") {
		const last = store[store.length - 1];
		const newest = store.reduce((a, b) => ((b.savedAt ?? 0) > (a.savedAt ?? 0) ? b : a), store[0]);
		if (newest !== last) {
			console.error(`testkit log: WARNING — the last array element (${last.transferId}) is not the `
				+ `newest by savedAt (${newest.transferId}). Using the last element, as `
				+ "get-transaction-log.ps1 does; name the id explicitly if you meant the other one.");
		}
		return { entry: last, index: store.length - 1 };
	}
	const index = store.findIndex(entry => entry.transferId === selector);
	if (index === -1) {
		const known = store.slice(-20).map(entry => entry.transferId);
		throw new Error(`no transaction log for "${selector}". The store holds ${store.length} entr`
			+ `${store.length === 1 ? "y" : "ies"}; the most recent ${known.length}:\n  ${known.join("\n  ")}`);
	}
	return { entry: store[index], index };
}

/** List debug_* / failure_black_box_* dumps on one host's instance. */
export function listDumps(host, glob = "*.json") {
	if (!/^[A-Za-z0-9_.*?-]+$/.test(glob)) {
		throw new Error(`refusing glob "${glob}": only [A-Za-z0-9_.*?-] are allowed. Quoting a hostile `
			+ "glob is harder to get right than refusing one.");
	}
	const instance = `clusterio-host-${host}-instance-1`;
	const container = `surface-export-host-${host}`;
	const dir = PATHS.instanceScriptOutput.pathTemplate.replace("<instance>", instance);
	// sh -c is required here for the glob; the redirect is scoped to `find` and cannot touch our JSON.
	const raw = dockerRead(["exec", container, "sh", "-c",
		`find ${dir} -maxdepth 1 -name '${glob}' -printf '%T@ %s %p\\n' 2>/dev/null | sort -rn`],
	{ what: `listing dumps on host ${host}` });
	return String(raw).split("\n").map(line => line.trim()).filter(Boolean).map(line => {
		const [mtime, size, ...rest] = line.split(" ");
		return { mtime: Number(mtime), size: Number(size), path: rest.join(" ") };
	});
}

/** Read one dump by exact path inside the host container. */
export function readDump(host, path) {
	const container = `surface-export-host-${host}`;
	const raw = dockerRead(["exec", container, "cat", path], { what: `reading ${container}:${path}` });
	return parseJsonDoc(raw, `${container}:${path}`);
}

function parseJsonDoc(raw, source) {
	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new Error(`${source} is not valid JSON (${error.message}). First 400 chars:\n`
			+ `${String(raw).trim().slice(0, 400)}`);
	}
}

/** A one-line header identifying WHICH record answered — without it, a right-looking value from the
 *  wrong record is indistinguishable from the right answer. */
export function describeEntry(entry, index, total) {
	const summary = entry.summary || {};
	const bits = [entry.transferId, summary.platformName || entry.transferInfo?.platformName || "?",
		`${summary.status || entry.transferInfo?.status || "?"}/${summary.result || "?"}`];
	if (summary.totalDurationStr) bits.push(summary.totalDurationStr);
	bits.push(`(store entry ${index} of ${total})`);
	return bits.join("  ");
}

/** Format a resolved value for stdout. */
export function formatValue(path, value) {
	if (value !== null && typeof value === "object") {
		const kind = Array.isArray(value) ? `array of ${value.length}` : "object";
		return `${path} = ${kind}\n${JSON.stringify(value, null, 2)}`;
	}
	return `${path} = ${JSON.stringify(value)}`;
}

export { exitCodeFor, resolvePath };
