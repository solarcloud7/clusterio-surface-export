// requires: matching Node/Lua runtime and identity-bearing platform observations
// produces: one exact operation's completion and destination release identity
// does not: clone, delete, unlock, or replay a transfer on missing status
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

export function quote(value) {
	assert.ok(typeof value === "string" && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value), "Invalid Lua string");
	return JSON.stringify(value);
}

export function array(value) {
	if (value && !Array.isArray(value) && typeof value === "object" && !Object.keys(value).length) return [];
	assert.ok(Array.isArray(value), "Expected a record array");
	return value;
}

export function checked(result) {
	assert.equal(result?.success, true, result?.error || "Lua observation unavailable");
	return result;
}

export function identity(platform) {
	assert.ok(platform, "Platform unavailable");
	for (const key of ["platform_index", "surface_index"]) {
		assert.ok(Number.isSafeInteger(platform[key]) && platform[key] > 0, `Invalid ${key}`);
	}
	assert.equal(platform.force_name, "player", "Unexpected platform force");
	quote(platform.platform_uid);
	return platform;
}

export function unique(rows, predicate, label) {
	const matches = rows.filter(predicate);
	assert.ok(matches.length <= 1, `Ambiguous ${label}`);
	return matches[0];
}

export function currentLua(platform) {
	identity(platform);
	return `local p=game.forces.player.platforms[${platform.platform_index}]
assert(p and p.valid and p.surface and p.surface.valid and p.surface.index==${platform.surface_index},'Probe platform location changed')
local matched=false
for _,record in pairs(remote.call('surface_export','list_platforms','player')) do
 if record.platform_index==p.index and record.platform_uid==${quote(platform.platform_uid)} then matched=true end
end
assert(matched,'Probe platform identity changed')`;
}

export function destinationReceiptLua(transferId) {
	return `local bucket=(storage.surface_export_transfer_receipts or {}).destination_live
local receipt=bucket and bucket.records[${quote(transferId)}]
return {success=true,receipt=receipt}`;
}

export async function waitForTransfer({ read, transferId, sourceId, targetId, timeoutMs, sleep,
	now = () => performance.now() }) {
	const deadline = now() + timeoutMs;
	let last;
	while (now() < deadline) {
		last = unique(array(await read()), row => row.transferId === transferId, "transfer record");
		if (last) {
			assert.equal(last.sourceInstanceId, sourceId, "Transfer source mismatch");
			assert.equal(last.targetInstanceId, targetId, "Transfer destination mismatch");
			assert.equal(last.operationType, "transfer", "Unexpected operation type");
			if (["failed", "cancelled", "cleanup_failed", "rolled_back"].includes(last.status)) {
				throw new Error(`Transfer ${transferId} ${last.status}: ${last.error || "inspect its retained details"}`);
			}
			if (last.status === "completed") {
				assert.ok(Number.isFinite(last.completedAt) && !last.error && !last.lateDestinationCleanup
					&& !last.timingPendingRecovery, "Transfer still has unresolved recovery");
				return last;
			}
		}
		await sleep(500);
	}
	throw new Error(`Transfer ${transferId} completion unavailable after ${timeoutMs} ms; platforms retained (${last?.status || "missing status"})`);
}


export const listPlatforms = async (io, host) => array(checked(await io.lua(host,
	"return {success=true,platforms=remote.call('surface_export','list_platforms','player')}")).platforms);

export async function transferPlatform({ platform, source, target, ids, timeoutMs = 300_000 }, io) {
	identity(platform);
	assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, "Invalid timeout");
	for (const host of [source, target]) assert.ok(Number.isSafeInteger(ids[host]) && ids[host] > 0, "Instance ID unavailable");
	assert.notEqual(ids[source], ids[target], "Source and destination must differ");
	const report = io.report ?? (() => {});
	const platforms = host => listPlatforms(io, host);
	let transferId;
	try {
		const started = checked(await io.lua(source, `${currentLua(platform)}
local id,err=remote.call('surface_export','export_platform',p.index,'player',${ids[target]},nil,${quote(platform.platform_uid)})
return {success=type(id)=='string',jobId=id,error=err}`));
		assert.match(started.jobId, /^[A-Za-z0-9_-]+$/);
		transferId = `${ids[source]}:${started.jobId}`;
		report(`Tracking transfer ${transferId}`);
		const summary = await waitForTransfer({
			read: async () => JSON.parse(String(await io.ctl("surface-export", "list-transfers", "500")).trim().split(/\r?\n/).at(-1)),
			transferId, sourceId: ids[source], targetId: ids[target], timeoutMs, sleep: io.sleep, now: io.now,
		});
		const receipt = checked(await io.lua(target, destinationReceiptLua(transferId))).receipt;
		assert.equal(receipt?.transfer_id, transferId, "Destination release receipt unavailable");
		const destination = identity(unique(await platforms(target), p => p.platform_index === receipt.platform_index, "destination"));
		for (const field of ["platform_uid", "surface_index", "force_name"]) {
			assert.equal(destination[field], receipt[field], `Destination ${field} changed`);
		}
		assert.ok(!(await platforms(source)).some(p => p.platform_index === platform.platform_index
			|| p.platform_uid === platform.platform_uid), "Source copy still present or its slot was reused; preserve platforms");

		return { transferId, summary, source: platform, destination };
	} catch (error) {
		if (transferId) error.transferId = transferId;
		throw error;
	}
}

export async function runPlatformTransfer({ platformIndex, direction, timeoutMs = 300_000 }, io) {
	assert.ok(Number.isSafeInteger(platformIndex) && platformIndex > 0, "Invalid platform index");
	assert.ok(["1to2", "2to1"].includes(direction), "Invalid direction");
	const [source, target] = direction === "1to2" ? [1, 2] : [2, 1];
	const ids = await io.instanceIds();
	const platform = identity(unique(await listPlatforms(io, source), p => p.platform_index === platformIndex, "source platform"));
	return transferPlatform({ platform, source, target, ids, timeoutMs }, io);
}
