import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { exitCodeFor, resolvePath } from "./path-oracle.mjs";

const PATHS = JSON.parse(readFileSync(
	fileURLToPath(new URL("../../shared/cluster-paths.json", import.meta.url)), "utf8"));

export const STORE = PATHS.transactionLogStore;

function dockerRead(args, { what }) {
	try {
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

export function readTransactionLogStore() {
	const raw = dockerRead(["exec", STORE.container, "cat", STORE.path],
		{ what: `reading ${STORE.container}:${STORE.path}` });
	return parseStore(raw, `${STORE.container}:${STORE.path}`);
}

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
	if (!trimmed) return [];
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

export function listDumps(host, glob = "*.json") {
	if (!/^[A-Za-z0-9_.*?-]+$/.test(glob)) {
		throw new Error(`refusing glob "${glob}": only [A-Za-z0-9_.*?-] are allowed. Quoting a hostile `
			+ "glob is harder to get right than refusing one.");
	}
	const instance = `clusterio-host-${host}-instance-1`;
	const container = `surface-export-host-${host}`;
	const dir = PATHS.instanceScriptOutput.pathTemplate.replace("<instance>", instance);
	const raw = dockerRead(["exec", container, "sh", "-c",
		`find ${dir} -maxdepth 1 -name '${glob}' -printf '%T@ %s %p\\n' 2>/dev/null | sort -rn`],
	{ what: `listing dumps on host ${host}` });
	return String(raw).split("\n").map(line => line.trim()).filter(Boolean).map(line => {
		const [mtime, size, ...rest] = line.split(" ");
		return { mtime: Number(mtime), size: Number(size), path: rest.join(" ") };
	});
}

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

export function describeEntry(entry, index, total) {
	const summary = entry.summary || {};
	const bits = [entry.transferId, summary.platformName || entry.transferInfo?.platformName || "?",
		`${summary.status || entry.transferInfo?.status || "?"}/${summary.result || "?"}`];
	if (summary.totalDurationStr) bits.push(summary.totalDurationStr);
	bits.push(`(store entry ${index} of ${total})`);
	return bits.join("  ");
}

export function formatValue(path, value) {
	if (value !== null && typeof value === "object") {
		const kind = Array.isArray(value) ? `array of ${value.length}` : "object";
		return `${path} = ${kind}\n${JSON.stringify(value, null, 2)}`;
	}
	return `${path} = ${JSON.stringify(value)}`;
}

export { exitCodeFor, resolvePath };
