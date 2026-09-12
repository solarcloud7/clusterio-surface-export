const { test } = require("node:test");
const assert = require("node:assert/strict");
const { shipPhaseFor, groupEdgeShips } = require("../dist/node/shared/transfer-status");
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm"),ts=require("typescript");
const motion={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,"../web/gateway/transfer-motion.ts"),"utf8"),
	{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:motion,require:name=>
	name==="./ship-motion"?{}:require("../dist/node/shared/transfer-status")});

test("resumed healthy work keeps its phase and job observation", () => {
	for (const status of ["preparing", "transporting", "awaiting_validation"]) {
		const summary = { status, timingPendingRecovery: true,
			jobObservation: { message: "Waiting in Lua queue", phase: "entities" } };
		assert.equal(shipPhaseFor(summary).tone, shipPhaseFor(status).tone);
		if (status !== "transporting") {
			assert.match(groupEdgeShips([summary], () => false).markers[0].label, /Waiting in Lua queue/);
		}
	}
	assert.equal(shipPhaseFor({ status: "in_progress", timingPendingRecovery: true }), null);
});

test("recorded failed rollback survives retention without the timing flag", () => {
	for (const sourceRollback of ["attempted", "failed"]) {
		const row = { transferId: `rollback-${sourceRollback}`, status: "failed", sourceRollback,
			registrySource: "persisted", operationType: "transfer", sourceInstanceId: 1, targetInstanceId: 2 };
		assert.equal(shipPhaseFor(row).terminal, false);
		assert.equal(motion.shipsInFlight([row], 100000).length, 1);
	}
});

test("historical cleanup failures expire while unresolved markers start at their observed position", () => {
	const row = { transferId: "old-cleanup", status: "cleanup_failed", registrySource: "persisted",
		operationType: "transfer", sourceInstanceId: 1, targetInstanceId: 2 };
	assert.equal(motion.shipsInFlight([row], 100000).length, 0);
	const live = { ...row, registrySource: "active" };
	assert.equal(motion.shipsInFlight([live], 100000).length, 1);
	for (const reversed of [true, false]) {
		assert.equal(motion.initialShipDistance(live, reversed), 0.5);
	}
});

test("debug scenarios and replay candidates preserve recovery presentation", () => {
	const debug = {};
	vm.runInNewContext(ts.transpileModule(
		fs.readFileSync(path.join(__dirname, "../web/gateway/debug-mode.ts"), "utf8"),
		{ compilerOptions: { module: ts.ModuleKind.CommonJS } },
	).outputText, { exports: debug, require: name => name === "./transfer-motion" ? motion
		: name === "./gateway-graph" ? {} : require(name) });
	for (const presentation of [
		{ status: "failed", sourceRollback: "succeeded" },
		{ status: "failed", sourceRollback: "failed" },
		{ status: "cleanup_failed", timingPendingRecovery: true },
	]) {
		const ships = debug.scenarioToShips({ instances: [{}, {}], ships: [{ from: 0, to: 1, ...presentation }] });
		const candidate = debug.replayCandidates(ships)[0];
		assert.equal(shipPhaseFor(candidate).label, shipPhaseFor(presentation).label);
		assert.equal(shipPhaseFor(debug.replayShips(ships, [candidate.transferId])[0]).label,
			shipPhaseFor(presentation).label);
	}
});

test("log summary conversion replaces stale rollback claims and preserves explicit false", () => {
	const utils = {};
	vm.runInNewContext(ts.transpileModule(
		fs.readFileSync(path.join(__dirname, "../web/utils.ts"), "utf8"),
		{ compilerOptions: { module: ts.ModuleKind.CommonJS } },
	).outputText, { exports: utils, require: name => require(`../dist/node/${name.slice(3)}`) });
	let rows = [{ transferId: "live", status: "failed", sourceRollback: "succeeded", sourceRestored: true }];
	for (const outcome of ["attempted", "failed", "succeeded"]) {
		const restored = outcome === "succeeded";
		const incoming = utils.summaryFromTransferInfo({ transferId: "live", status: "failed",
			sourceRollback: outcome, sourceRestored: restored, timingPendingRecovery: !restored, registrySource: "active",
			jobObservation: { message: "Recorded job state" } }, 10);
		rows = utils.mergeTransferSummary(rows, incoming);
		assert.equal(rows[0].sourceRollback, outcome);
		assert.equal(rows[0].sourceRestored, restored);
		assert.equal(rows[0].timingPendingRecovery, !restored);
		assert.equal(rows[0].registrySource, "active");
		assert.equal(rows[0].jobObservation.message, "Recorded job state");
		assert.equal(shipPhaseFor(rows[0]).terminal, restored);
	}
});

test("unresolved recovery never claims a return or arrival", () => {
	for (const status of ["error", "failed", "cleanup_failed"]) {
		const summary = { status, timingPendingRecovery: true, sourceRestored: true };
		const phase = shipPhaseFor(summary);
		assert.ok(phase, "recovery must remain visible");
		assert.equal(phase.terminal, false);
		assert.equal(phase.distance, .5);
		assert.equal(phase.holding, true);
		assert.doesNotMatch(groupEdgeShips([summary], () => false).markers[0].label, /returned|arrived|timed out/);
	}
});
test("recovery remains visible after reload and gets a fresh linger window when resolved",()=>{
	const pending = { transferId: "recover", status: "error", timingPendingRecovery: true,
		operationType: "transfer", sourceInstanceId: 1, targetInstanceId: 2 };
	assert.equal(motion.shipsInFlight([pending],100000).length,1);
	motion.noteTerminalSeen("recover",1);motion.noteLiveSeen("recover");
	assert.equal(motion.shipExpiryMs(pending,100000),null);
	const done={...pending,status:"completed",timingPendingRecovery:false};
	assert.equal(motion.shipExpiryMs(done,100000),110000);
	motion.noteTerminalSeen("recover",100000);
	assert.equal(motion.shipsInFlight([done],110001).length,0);
});

test("only confirmed source recovery claims a return; historical errors remain neutral", () => {
	assert.equal(shipPhaseFor({status:"failed",sourceRestored:true}).distance,0);
	assert.match(shipPhaseFor({status:"failed",sourceRestored:true}).label,/returned/);
	for(const status of ["failed","error","cleanup_failed"]) {
		assert.doesNotMatch(shipPhaseFor(status).label,/returned|arrived|timed out/);
		assert.equal(shipPhaseFor(status).distance,.5);
	}
	assert.equal(shipPhaseFor("completed").distance,1);
});
