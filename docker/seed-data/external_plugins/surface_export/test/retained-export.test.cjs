"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {InstancePlugin} = require("../dist/node/instance.js");
const {ReadExportRequest} = require("../dist/node/messages.js");

test("retained export read uses the original cache key and refuses runtime changes", async () => {
	const plugin = Object.create(InstancePlugin.prototype);
	plugin.timingEpoch = "runtime";
	plugin.recoveryStatus = {state: "ready"};
	plugin.withTiming = async (_job, _export, _stage, fn) => fn();
	let reads = 0;
	const data = {platform_name: "fixture", entities: []};
	plugin.getExportData = async id => {reads++; assert.equal(id, "job:with-colons"); return data;};
	const request = new ReadExportRequest("job:with-colons", "runtime");
	assert.deepEqual(await plugin.handleReadExportRequest(request), {
		success: true, exportId: request.exportId, epoch: request.epoch, exportData: data,
	});
	await assert.rejects(plugin.handleReadExportRequest(new ReadExportRequest(request.exportId, "old")), /runtime/);
	assert.equal(reads, 1);
	plugin.getExportData = async () => {plugin.timingEpoch = "next"; return data;};
	await assert.rejects(plugin.handleReadExportRequest(request), /runtime/);
	plugin.timingEpoch = "runtime";
	plugin.getExportData = async () => null;
	assert.equal((await plugin.handleReadExportRequest(request)).success, false);
	plugin.recoveryStatus.state = "reconciling";
	await assert.rejects(plugin.handleReadExportRequest(request), /not ready/);
});
