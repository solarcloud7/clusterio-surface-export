"use strict";

const path = require("node:path");
const { LineageRegistry } = require(path.join(__dirname, "..", "dist", "node", "lib", "lineage-registry.js"));

const HARNESS_LINEAGE = "lineage:harness-boot:3";

function withLineage(exportData, generation = 0) {
	return { lineage: HARNESS_LINEAGE, generation, ...exportData };
}

async function mirrorHold(activeTransfers, msg, reply) {
	const result = await reply;
	if (msg?.constructor?.name !== "DestinationTransferGateRequest" || msg.action !== "verify"
		|| !result?.success || "lineage" in result) return result;
	const transfer = activeTransfers.get(msg.transferId);
	if (!transfer?.lineage) return result;
	return { ...result, lineage: transfer.lineage, generation: transfer.lineageGeneration + 1 };
}

function presenceOf(answer = () => ({ state: "absent" })) {
	return async wanted => new Map([...wanted].flatMap(([instanceId, lineages]) =>
		[...lineages].map(lineage => [`${instanceId}\u0000${lineage}`, answer(instanceId, lineage)])));
}

module.exports = { HARNESS_LINEAGE, LineageRegistry, withLineage, mirrorHold, presenceOf };
