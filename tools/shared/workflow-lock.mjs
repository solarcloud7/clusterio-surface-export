// Shared by PowerShell builds/deploys and browser checks in the canonical checkout.
import { openSync, readFileSync, writeFileSync, closeSync, unlinkSync, mkdirSync } from "node:fs";
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

export function acquireWorkflowLock(path = workflowLockPath) {
	mkdirSync(dirname(path), { recursive: true });
	const previous = process.env.SE_WORKFLOW_TOKEN;
	const source = workflowLockSource();
	let owner;
	try { owner = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
		if (error.code !== "ENOENT") throw new Error(`Cannot read workflow lock ${path}: ${error.message}`);
	}
	if (previous && owner?.token === previous) return () => {};
	let fd;
	try { fd = openSync(path, "wx"); } catch (error) {
		if (error.code !== "EEXIST") throw error;
		const described = owner ? `PID ${owner.pid}, branch ${owner.branch} at ${owner.commit}, started ${owner.startedAt}` : "PID starting";
		throw new Error(`Build/deploy/browser workflow already owns ${path} (${described}). `
			+ "Wait for it to finish. After a crash, verify that owner has stopped before removing the lock.");
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
