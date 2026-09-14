#!/usr/bin/env node
// requires: a running development cluster and a source fixture
// produces: one operation's completed transfer and guarded fixture cleanup, or a nonzero exit
// does not: replay transfers, remove unresolved platforms, or certify independent cargo parity
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import * as cluster from "../../tests/lab-gallery/batch-lifecycle.mjs";
import { withWorkflowLock } from "../shared/workflow-lock.mjs";
import { runTransferProbe } from "./transfer-probe.mjs";

try {
	const { values } = parseArgs({ args: process.argv.slice(2), options: {
		fixture: { type: "string" }, "source-platform": { type: "string" },
		direction: { type: "string", default: "1to2" }, name: { type: "string" },
		lua: { type: "string" }, keep: { type: "boolean", default: false },
		"timeout-ms": { type: "string", default: "300000" }, help: { type: "boolean" },
	} });
	if (values.help) {
		console.log("probe-transfer [--fixture INDEX | --source-platform NAME] [--direction 1to2|2to1] "
			+ "[--name UNIQUE_NAME] [--lua PREPARATION] [--keep] [--timeout-ms 300000]");
	} else {
		await withWorkflowLock(() => runTransferProbe({
			fixtureIndex: values.fixture === undefined ? (values["source-platform"] ? undefined : 21) : Number(values.fixture),
			sourcePlatform: values["source-platform"], direction: values.direction,
			name: values.name ?? `probe-${randomUUID()}`, preparation: values.lua,
			keep: values.keep, timeoutMs: Number(values["timeout-ms"]),
		}, { ...cluster, report: console.log }));
	}
} catch (error) {
	console.error(`FAIL ${error.message}`);
	process.exitCode = 1;
}
