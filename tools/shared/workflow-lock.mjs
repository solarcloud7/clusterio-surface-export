// Shared by PowerShell builds/deploys and browser checks in the canonical checkout.
import { openSync, readFileSync, writeFileSync, closeSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export const workflowLockPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../ci-artifacts/workflow.lock");

export function acquireWorkflowLock(path = workflowLockPath) {
	mkdirSync(dirname(path), { recursive: true });
	const previous = process.env.SE_WORKFLOW_TOKEN;
	let owner;
	try { owner = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
		if (error.code !== "ENOENT") throw new Error(`Cannot read workflow lock ${path}: ${error.message}`);
	}
	if (previous && owner?.token === previous) return () => {};
	let fd;
	try { fd = openSync(path, "wx"); } catch (error) {
		if (error.code !== "EEXIST") throw error;
		throw new Error(`Build/deploy/browser workflow already owns ${path} (PID ${owner?.pid ?? "starting"}). `
			+ "Wait for it to finish. After a crash, verify that owner has stopped before removing the lock.");
	}
	process.env.SE_WORKFLOW_TOKEN = randomUUID();
	writeFileSync(fd, JSON.stringify({ pid: process.pid, token: process.env.SE_WORKFLOW_TOKEN }));
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
