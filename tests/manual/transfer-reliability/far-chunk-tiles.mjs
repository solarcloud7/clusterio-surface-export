#!/usr/bin/env node
// requires: Docker with the pinned lab images, a staged package under ci-artifacts (--package-dir)
// produces: ci-artifacts/se-manual-*/result.json with an engine probe of tiles set in an ungenerated platform chunk,
//           the measured cost of force-generating 52 platform chunks, and a transfer whose foundation reaches
//           ungenerated destination chunks: source census, transfer outcome, destination census before and
//           after the destination chunks generate, and a far chest's cargo
// does not: touch the development cluster, prove client-side chunk generation triggers, or measure other platforms
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { withWorkflowLock } from "../../../tools/shared/workflow-lock.mjs";
import { DockerLab, ROOT, hash } from "./docker-lab.mjs";
import { runLab } from "./lifecycle.mjs";
import { start, summary, terminal } from "./cases.mjs";

const { values } = parseArgs({ options: { "package-dir": { type: "string" } } });
assert.ok(values["package-dir"], "--package-dir is required");
const packageDirectory = resolve(ROOT, values["package-dir"]);
const within = relative(join(ROOT, "ci-artifacts"), packageDirectory);
assert.ok(within && !within.startsWith("..") && !isAbsolute(within), "package must be under ci-artifacts");

await withWorkflowLock(async () => {
	const run = `se-manual-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
	const directory = join(ROOT, "ci-artifacts", run);
	mkdirSync(directory, { recursive: true });
	const lab = new DockerLab(run, directory, { packageDirectory });
	const code = readFileSync(new URL("./far-chunk-tiles.lua", import.meta.url), "utf8");
	const call = (host, action, name) => lab.lua(host, `return (function() ${code} end)()('${action}','${name}')`);
	const report = { run, kind: "far-chunk-tiles", packageDirectory: within,
		hashes: { "far-chunk-tiles.mjs": hash(new URL(import.meta.url)), "far-chunk-tiles.lua": hash(new URL("./far-chunk-tiles.lua", import.meta.url)) } };
	const file = join(directory, "result.json"), save = () => writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
	process.exitCode = await runLab({ lab, report, save, work: async () => {
		report.environment = await lab.setup();
		lab.deadline = Date.now() + 900_000;
		const engine = `transfer-cleanup-${run}-engine`;
		report.engine = call(2, "engine", engine).result;
		const cost = call(2, "cost", engine);
		report.engine.cost = { raw: cost.raw.trim().split(/\r?\n/).find(line => line.startsWith("COST")), ungenerated: cost.result.ungenerated };
		save();
		const name = `transfer-cleanup-${run}-far`;
		lab.probe(1, "build", name);
		report.source = call(1, "extend", name).result.census;
		save();
		const id = start(lab, name);
		report.transferId = id;
		report.outcome = await terminal(lab, id).catch(() => summary(lab, id));
		save();
		report.destinationBefore = call(2, "census", name).result;
		report.destinationAfter = call(2, "generate", name).result;
		report.sourceAfter = call(1, "census", name).result;
		report.destinationLog = lab.docker(["exec", lab.hosts[2].container, "sh", "-c",
			"grep -h -E 'chunk_generation|tile_census|tile_comparison|Payload chunks before tile placement|Tile placement result|TransferValidation' /clusterio/data/instances/*/factorio-current.log | tail -n 80"])
			.trim().split(/\r?\n/);
		save();
		report.gate = call(2, "gate", `transfer-cleanup-${run}-gate`).result;
		save();
	}, analyze: () => {
		if (report.error) return {};
		const lost = report.source.total - report.destinationAfter.census.total;
		return { verdict: "PASS", observation: { engineLateGenerationKept: report.engine.late.after_generation,
			engineGenerateFirstKept: report.engine.generate_first.after_neighbour_generation,
			transferStatus: report.outcome?.status, sourceTiles: report.source.total,
			destinationTilesBeforeGeneration: report.destinationBefore.census?.total,
			destinationTilesAfterGeneration: report.destinationAfter.census.total, lost,
			farChestIronPlates: report.destinationBefore.far_chest } };
	} });
	save();
	console.log(JSON.stringify({ artifact: file, verdict: report.verdict, error: report.error,
		cleanup: report.cleanup?.success, observation: report.observation }, null, 2));
});
