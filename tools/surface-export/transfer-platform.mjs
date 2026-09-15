#!/usr/bin/env node
// requires: a running development cluster and a source platform index
// produces: the selected transfer's completion and released destination identity, or a nonzero exit
// does not: replay uncertain requests or delete test fixtures
import { parseArgs } from "node:util";
import { developmentCluster } from "../shared/cluster-transport.mjs";
import { withWorkflowLock } from "../shared/workflow-lock.mjs";
import { runPlatformTransfer } from "./platform-transfer.mjs";

try {
	const { values } = parseArgs({ options: {
		platform: { type: "string" }, direction: { type: "string" }, "timeout-ms": { type: "string", default: "300000" },
	} });
	const result = await withWorkflowLock(() => runPlatformTransfer({ platformIndex: Number(values.platform),
		direction: values.direction, timeoutMs: Number(values["timeout-ms"]),
	}, { ...developmentCluster, report: console.log }));
	console.log(JSON.stringify(result));
} catch (error) {
	console.error(`Transfer ${error.transferId ?? "request"} failed or unavailable: ${error.message}. Inspect retained transfer details before retrying.`);
	process.exitCode = 1;
}
