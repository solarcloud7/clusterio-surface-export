// Shared by PowerShell builds/deploys and browser checks in the canonical checkout.
import { openSync, readFileSync, writeFileSync, closeSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const workflowLockPath = resolve(checkout, "ci-artifacts/workflow.lock");

function gitValue(args) {
	const result = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	return result.status === 0 ? result.stdout.trim() : null;
}

export function workflowLockSource() {
	return { checkout, branch: gitValue(["rev-parse", "--abbrev-ref", "HEAD"]),
		commit: gitValue(["rev-parse", "--short=12", "HEAD"]), startedAt: new Date().toISOString() };
}

export function processExists(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return true;
	try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

function readOwner(path) {
	try { return JSON.parse(readFileSync(path, "utf8")); } catch (error) {
		if (error.code === "ENOENT") return undefined;
		throw new Error(`Cannot read workflow lock ${path}: ${error.message}`);
	}
}

// A lock file is only ever created when absent (exclusive create) or removed by its owner. Removing a
// dead owner's lock is the one other change, and it happens only while holding the exclusively created
// reclaim file, so no second reclaimer can delete a lock that a first one has already replaced.
function reclaimStale(path, owner, { exists, log, beforeRemove }) {
	const reclaimPath = `${path}.reclaim`;
	let fd;
	try { fd = openSync(reclaimPath, "wx"); } catch (error) {
		if (error.code === "EEXIST") return false;
		throw error;
	}
	try {
		const current = readOwner(path);
		if (!current || current.token !== owner.token || exists(current.pid)) return false;
		beforeRemove?.();
		unlinkSync(path);
		log(`Reclaimed a stale workflow lock: PID ${owner.pid} (branch ${owner.branch} at ${owner.commit}, started ${owner.startedAt}) is no longer running.`);
		return true;
	} finally {
		closeSync(fd);
		unlinkSync(reclaimPath);
	}
}

export function acquireWorkflowLock(path = workflowLockPath, { exists = processExists, log = message => console.warn(message), beforeRemove } = {}) {
	mkdirSync(dirname(path), { recursive: true });
	const previous = process.env.SE_WORKFLOW_TOKEN;
	const source = workflowLockSource();
	let owner = readOwner(path);
	if (previous && owner?.token === previous) return () => {};
	if (owner?.token && !exists(owner.pid) && reclaimStale(path, owner, { exists, log, beforeRemove })) owner = undefined;
	let fd;
	try { fd = openSync(path, "wx"); } catch (error) {
		if (error.code !== "EEXIST") throw error;
		owner = readOwner(path) ?? owner;
		const described = owner ? `PID ${owner.pid}, branch ${owner.branch} at ${owner.commit}, started ${owner.startedAt}` : "PID starting";
		const reclaiming = existsSync(`${path}.reclaim`) ? ` Another process is reclaiming it (${path}.reclaim); if none is, remove that file.` : "";
		throw new Error(`Build/deploy/browser workflow already owns ${path} (${described}). `
			+ "Wait for it to finish. After a crash, verify that owner has stopped before removing the lock." + reclaiming);
	}
	process.env.SE_WORKFLOW_TOKEN = randomUUID();
	writeFileSync(fd, JSON.stringify({ pid: process.pid, token: process.env.SE_WORKFLOW_TOKEN, ...source }));
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		process.removeListener("exit", release);
		if (previous === undefined) delete process.env.SE_WORKFLOW_TOKEN;
		else process.env.SE_WORKFLOW_TOKEN = previous;
		closeSync(fd); unlinkSync(path);
	};
	process.once("exit", release);
	return release;
}

export async function withWorkflowLock(work, path = workflowLockPath) {
	const release = acquireWorkflowLock(path);
	try { return await work(); } finally { release(); }
}
