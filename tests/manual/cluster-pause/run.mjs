#!/usr/bin/env node
// requires: Docker with the pinned lab images; a stage directory under ci-artifacts holding built surface_export and cluster_pause packages (--package-dir)
// produces: ci-artifacts/se-manual-*/result.json with engine observations of game.tick_paused on a dedicated server (script pause, RCON while paused,
//           a save and a Clusterio stop while paused, the next start), and the cluster_pause phases on two instances: countdown, draining held by a
//           transfer in flight, paused, admission refused while paused, resume; game ticks are read on each server, not taken from the plugin
// does not: touch the development cluster, connect a game client, or prove behaviour on other Factorio versions or with other plugins loaded
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { withWorkflowLock } from "../../../tools/shared/workflow-lock.mjs";
import { DockerLab, ROOT, hash, sleep, validRun } from "../transfer-reliability/docker-lab.mjs";
import { startClient, stopClient, screenshot, clientLog } from "./client.mjs";
import { runLab } from "../transfer-reliability/lifecycle.mjs";
import { expectedCargo } from "../../integration/transfer-cleanup/oracle.mjs";

const { values } = parseArgs({ options: {
	"package-dir": { type: "string" },
	phases: { type: "string", default: "engine,cluster" },
	keep: { type: "boolean", default: false },
	attach: { type: "string" },
	"client-image": { type: "string" },
} });
assert.ok(values["package-dir"], "--package-dir is required");
const stage = resolve(ROOT, values["package-dir"]);
const within = relative(join(ROOT, "ci-artifacts"), stage);
assert.ok(within && !within.startsWith("..") && !isAbsolute(within), "package stage must be under ci-artifacts");
const phases = new Set(values.phases.split(","));
assert.ok([...phases].every(phase => ["engine", "cluster", "client"].includes(phase)), "phases: engine, cluster, client");
assert.ok(!phases.has("client") || /^surface-export-client-gui:[a-f0-9]{16}$/.test(values["client-image"] ?? ""),
	"the client phase needs --client-image surface-export-client-gui:<tag> (build it with tools/tests/testkit/client/Dockerfile)");
assert.ok(!values.attach || validRun(values.attach), "--attach takes a kept se-manual run id");

const PAUSE_SECONDS = 4;

await withWorkflowLock(async () => {
	const run = values.attach ?? `se-manual-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
	const directory = join(ROOT, "ci-artifacts", run);
	mkdirSync(directory, { recursive: true });
	const lab = new DockerLab(run, directory, { packageDirectory: join(stage, "surface_export"),
		extraPlugins: [{ name: "cluster_pause", directory: join(stage, "cluster_pause") }],
		factorioSettings: phases.has("client") ? { require_user_verification: false } : {} });
	const report = { run, kind: "cluster-pause", stage: within, phases: [...phases], attached: Boolean(values.attach),
		hashes: { "run.mjs": hash(new URL(import.meta.url)), "client.mjs": hash(new URL("./client.mjs", import.meta.url)) } };
	const file = join(directory, values.attach ? `result-attach-${Date.now().toString(36)}.json` : "result.json");
	const save = () => writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
	const started = performance.now();
	const at = () => Math.round(performance.now() - started);
	const instance = host => lab.hosts[host].instance;

	const timed = action => {
		const t = performance.now();
		try { const value = action(); return { atMs: at(), ms: Math.round(performance.now() - t), value }; }
		catch (error) { return { atMs: at(), ms: Math.round(performance.now() - t), error: error.message }; }
	};
	const game = host => lab.lua(host, "return {success=true,tick=game.tick,paused=game.tick_paused,players=#game.connected_players}").result;
	const sampleTicks = async (host, seconds = PAUSE_SECONDS) => {
		const before = timed(() => game(host));
		await sleep(seconds * 1000);
		const after = timed(() => game(host));
		return { host, waitedMs: seconds * 1000, before, after,
			advanced: before.value && after.value ? after.value.tick - before.value.tick : null };
	};
	const setPaused = (host, paused) => timed(() => lab.lua(host, `return remote.call("cluster_pause","set_paused",${paused})`).result);
	const json = raw => JSON.parse(raw.slice(raw.indexOf("{")));
	const status = () => json(lab.ctl("cluster-pause", "status"));
	const controllerConfig = (field, value) => lab.ctl("controller", "config", "set", field, String(value));
	const saves = host => lab.docker(["exec", lab.hosts[host].container, "sh", "-c",
		`cd '/clusterio/data/instances/${instance(host)}/saves' && for f in *.zip; do echo "$(stat -c %Y "$f") $(sha256sum "$f" | cut -c1-16) $f"; done`])
		.trim().split(/\r?\n/).filter(Boolean);
	const controllerLog = pattern => lab.docker(["logs", lab.controller], { tailChars: 400000 }).split(/\r?\n/)
		.filter(line => line.includes(pattern));
	const transferRow = platformName => JSON.parse(lab.ctl("surface-export", "list-transfers", "200").trim().split(/\r?\n/).at(-1))
		.filter(row => row.platformName === platformName);
	const waitForGame = (host, seconds = 180) => lab.until(() => game(host), `RCON on ${instance(host)}`, seconds);
	const phaseLog = [];
	const waitForPhase = (phase, seconds) => lab.until(() => {
		const current = status();
		const last = phaseLog.at(-1);
		if (last?.phase !== current.phase || JSON.stringify(last?.holds) !== JSON.stringify(current.holds)) {
			phaseLog.push({ atMs: at(), phase: current.phase, reason: current.reason, holds: current.holds, paused: current.paused,
				confirmed: current.confirmed, countdownRemainingMs: current.countdownRemainingMs, hold: current.hold, lastError: current.lastError });
		}
		return current.phase === phase && current;
	}, `cluster phase ${phase}`, seconds);

	const keep = values.keep || values.attach;
	process.exitCode = await runLab({ lab, report, save, cleanup: keep ? async () => ({ success: true, kept: true }) : undefined, work: async () => {
		if (values.attach) {
			lab.ids = {};
			lab.deadline = Date.now() + 2_400_000;
			for (const row of lab.ctl("instance", "list").split(/\r?\n/)) {
				const [name, id] = row.split("|").map(cell => cell.trim());
				for (const host of [1, 2]) if (name === instance(host)) lab.ids[host] = Number(id);
			}
		} else report.environment = await lab.setup();
		lab.deadline = Date.now() + 2_400_000;
		report.loaded = { controller: controllerLog("cluster_pause").slice(0, 5), status: status() };
		save();

		if (phases.has("engine")) {
			const engine = report.engine = {};
			engine.checkpoint = await lab.checkpoint("manual-before-pause", [2]);
			engine.running = await sampleTicks(2, 2);
			engine.pause = setPaused(2, true);
			engine.held = [await sampleTicks(2), await sampleTicks(2)];
			engine.writeWhilePaused = timed(() => lab.lua(2, "storage.cluster_pause_lab = {tick=game.tick}; return {success=true,tick=game.tick}").result);
			engine.chatWhilePaused = timed(() => lab.ctl("instance", "send-rcon", instance(2), "cluster pause lab message").trim());
			save();
			engine.unpause = setPaused(2, false);
			engine.resumed = await sampleTicks(2, 2);
			save();

			engine.pauseForSave = setPaused(2, true);
			engine.savesBefore = saves(2);
			const saveStart = timed(() => lab.lua(2, "game.server_save('manual-paused'); return {success=true,tick=game.tick}").result);
			engine.serverSave = { request: saveStart };
			try { engine.serverSave.checkpoint = await lab.until(() => lab.checkpointHash(2, "manual-paused"), "save while paused", 60); }
			catch (error) { engine.serverSave.error = error.message; }
			engine.serverSave.atMs = at();
			engine.serverSave.afterSave = timed(() => game(2));
			engine.marker = timed(() => lab.lua(2, `storage.cluster_pause_lab = {marker="${run}", tick=game.tick}; return {success=true,tick=game.tick}`).result);
			save();

			engine.stop = timed(() => lab.ctl("instance", "stop", instance(2)).trim());
			engine.savesAfterStop = saves(2);
			engine.loadPluginOff = timed(() => lab.ctl("instance", "config", "set", instance(2), "cluster_pause.load_plugin", "false").trim());
			engine.startWithoutPlugin = timed(() => lab.ctl("instance", "start", instance(2)).trim());
			engine.afterStartWithoutPlugin = await waitForGame(2);
			engine.loadedWithoutPlugin = [await sampleTicks(2), timed(() => lab.lua(2,
				"return {success=true,lab=storage.cluster_pause_lab,interface=remote.interfaces.cluster_pause~=nil}").result)];
			save();

			engine.stopAgain = timed(() => lab.ctl("instance", "stop", instance(2)).trim());
			engine.loadPluginOn = timed(() => lab.ctl("instance", "config", "set", instance(2), "cluster_pause.load_plugin", "true").trim());
			engine.startWithPlugin = timed(() => lab.ctl("instance", "start", instance(2)).trim());
			engine.afterStartWithPlugin = await waitForGame(2);
			engine.resumedByPlugin = await lab.until(() => { const s = game(2); return !s.paused && s; }, "plugin resumes a paused save on start", 60)
				.then(value => ({ atMs: at(), value }), error => ({ atMs: at(), error: error.message }));
			engine.resumedByPluginTicks = await sampleTicks(2, 2);
			engine.resumeLog = controllerLog("resumed from the cluster pause");
			save();
			await lab.ready();
		}

		if (phases.has("cluster")) {
			const cluster = report.cluster = { phaseLog };
			const watchFile = "/tmp/cluster-pause-watch.log";
			lab.docker(["exec", "-d", lab.controller, "sh", "-c", `timeout -s INT 900 npx clusterioctl --log-level error --config /clusterio/tokens/config-control.json `
				+ `cluster-pause status --watch > ${watchFile} 2>&1`]);
			await sleep(5000);
			controllerConfig("cluster_pause.hold_check_interval_ms", 1000);
			cluster.enabledAtMs = at();
			controllerConfig("cluster_pause.enabled", true);
			cluster.countdown = await waitForPhase("countdown", 30);
			cluster.paused = await waitForPhase("paused", 120);
			cluster.pausedAtMs = at();
			cluster.frozen = [await sampleTicks(1), await sampleTicks(2)];
			save();

			const name = `transfer-cleanup-${run}-pause`, refused = `transfer-cleanup-${run}-refused`;
			cluster.resume = timed(() => json(lab.ctl("cluster-pause", "resume")));
			cluster.resumed = [await sampleTicks(1, 2), await sampleTicks(2, 2)];
			save();
			lab.probe(1, "build", name);
			lab.probe(1, "build", refused);
			cluster.source = lab.probe(1, "read", name).state;
			assert.deepEqual(cluster.source.cargo, expectedCargo, "fixture does not match the independent cargo contract");
			const index = lab.probe(1, "read", name).state.index;
			cluster.refusedBefore = lab.probe(1, "read", refused).state;
			cluster.transferStart = timed(() => lab.ctl("surface-export", "start-transfer", String(lab.ids[1]), String(index), String(lab.ids[2])).trim());
			const accepted = cluster.transferStart.value?.split(/\r?\n/).at(-1).match(/: (\S+)$/)?.[1];
			assert.ok(accepted, `transfer was not admitted: ${JSON.stringify(cluster.transferStart)}`);
			const transferId = accepted !== "pending" ? accepted : await lab.until(() => {
				const rows = JSON.parse(lab.ctl("surface-export", "list-transfers", "20").trim().split(/\r?\n/).at(-1));
				return rows.find(row => row.platformName === name)?.transferId;
			}, "admitted transfer listed", 30);
			cluster.transferId = transferId;
			cluster.pauseCommand = timed(() => json(lab.ctl("cluster-pause", "pause")));
			cluster.draining = cluster.pauseCommand.value;
			assert.equal(cluster.draining?.phase, "draining", `pause command did not start draining: ${JSON.stringify(cluster.pauseCommand)}`);
			cluster.pausedAfterTransfer = await waitForPhase("paused", 300);
			const ordered = lab.docker(["logs", lab.controller], { tailChars: 400000 }).split(/\r?\n/)
				.filter(line => !line.startsWith("[cluster-log]")).map((line, index) => ({ index, line }));
			const first = pattern => ordered.find(({ line }) => pattern.test(line))?.index ?? null;
			cluster.order = {
				drainingWithHold: first(new RegExp(`Cluster pause draining \\(command\\).*${transferId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)),
				exportRequested: first(/export_requested:.*transfer-cleanup-.*-pause|transfer-cleanup-.*-pause.*export_requested/),
				transferCompleted: first(/-pause_[^\]]*\] .*transfer_completed/),
				paused: ordered.filter(({ line }) => /Cluster pause paused \(holds_cleared\)/.test(line)).at(-1)?.index ?? null,
			};
			cluster.pausedAfterTransferAtMs = at();
			cluster.transfer = transferRow(name);
			cluster.frozenAfterTransfer = [await sampleTicks(1), await sampleTicks(2)];
			save();

			cluster.refusal = timed(() => lab.ctl("surface-export", "start-transfer", String(lab.ids[1]),
				String(cluster.refusedBefore.index), String(lab.ids[2])));
			cluster.refusedAfter = lab.probe(1, "read", refused).state;
			cluster.stillPaused = await sampleTicks(1, 2);
			save();

			cluster.resumeAgain = timed(() => json(lab.ctl("cluster-pause", "resume")));
			cluster.resumedAgain = [await sampleTicks(1, 2), await sampleTicks(2, 2)];
			cluster.destination = lab.probe(2, "read", name).state;
			cluster.sourceAfter = lab.probe(1, "read", name).state;
			cluster.transferFinal = transferRow(name);
			cluster.controllerLog = controllerLog("Cluster pause");
			lab.docker(["exec", lab.controller, "sh", "-c", "pkill -INT -f 'cluster-pause status --watch' || true"]);
			await sleep(1000);
			cluster.watch = lab.docker(["exec", lab.controller, "cat", watchFile]).split(/\r?\n/).filter(Boolean);
			save();
			for (const fixture of [name, refused]) {
				for (const host of [1, 2]) try { lab.probe(host, "cleanup", fixture); }
				catch (error) { (cluster.cleanupErrors ??= []).push(`${host} ${fixture}: ${error.message}`); }
			}
		}

		if (phases.has("client")) {
			const client = report.client = {};
			const image = values["client-image"];
			const interesting = /changing state|PlayerJoinGame|desync|disconnect|quit|error|dropped|timed out/i;
			const log = joined => clientLog(lab, joined).filter(line => interesting.test(line));
			const waitPlayers = (host, count, seconds) => lab.until(() => game(host).players === count && { atMs: at(), count },
				`${count} player(s) on ${instance(host)}`, seconds);
			for (const name of lab.docker(["ps", "-a", "--filter", `label=surface-export.manual-run=${run}`, "--format", "{{.Names}}"])
				.split(/\r?\n/).filter(name => name.startsWith(`${run}-client-`))) lab.mutateContainer("rm", name, ["-f"]);
			client.emptyBefore = await waitPlayers(1, 0, 180);

			controllerConfig("cluster_pause.enabled", false);
			client.disabled = await waitForPhase("running", 30);
			client.enginePause = setPaused(1, true);
			client.engineFrozen = await sampleTicks(1);
			const joining = startClient(lab, { host: 1, name: "client-paused-join", image });
			client.engineClient = { address: joining.address, mods: joining.mods };
			client.engineSamples = [];
			client.engineJoined = await lab.until(() => {
				const sample = { atMs: at(), ...game(1) };
				client.engineSamples.push(sample);
				return sample.players > 0 && sample;
			}, "client joins the paused server", 240).catch(error => ({ error: error.message }));
			client.engineWhileJoinedPaused = await sampleTicks(1);
			client.engineShotPaused = timed(() => screenshot(lab, joining, "joined-paused"));
			client.engineLogPaused = log(joining);
			save();
			client.engineUnpause = setPaused(1, false);
			client.engineAfterUnpause = [await sampleTicks(1), await sampleTicks(1, 10)];
			client.engineShotResumed = timed(() => screenshot(lab, joining, "joined-resumed"));
			client.engineLog = log(joining);
			stopClient(lab, joining);
			client.engineLeft = await waitPlayers(1, 0, 180);
			save();

			controllerConfig("cluster_pause.enabled", true);
			controllerConfig("cluster_pause.countdown_ms", 30000);
			client.pausedBeforeJoin = await waitForPhase("paused", 120);
			client.frozenBeforeJoin = [await sampleTicks(1), await sampleTicks(2)];
			client.pluginClientStartedAtMs = at();
			const player = startClient(lab, { host: 1, name: "client-plugin-join", image });
			client.resumedByJoin = await waitForPhase("running", 240);
			client.resumedByJoinAtMs = at();
			client.joinedAfterResume = await waitPlayers(1, 1, 120);
			client.bothRunning = [await sampleTicks(1), await sampleTicks(2)];
			client.pluginShot = timed(() => screenshot(lab, player, "plugin-join"));
			client.pluginLog = log(player);
			save();
			stopClient(lab, player);
			client.leftAtMs = at();
			client.countdownAfterLeave = await waitForPhase("countdown", 180);
			client.pausedAfterLeave = await waitForPhase("paused", 120);
			client.frozenAfterLeave = [await sampleTicks(1), await sampleTicks(2)];
			client.controllerLog = controllerLog("Cluster pause");
			client.resumeEnd = timed(() => json(lab.ctl("cluster-pause", "resume")));
			save();
		}
	}, analyze: () => {
		if (report.error) return {};
		const observation = {};
		const e = report.engine;
		if (e) {
			observation.engine = {
				scriptPauseHolds: e.held.every(sample => sample.advanced === 0 && sample.after.value?.paused === true),
				rconWhilePausedMs: e.held.flatMap(sample => [sample.before.ms, sample.after.ms]),
				resumeAdvancedTicks: e.resumed.advanced,
				serverSaveWhilePaused: e.serverSave.checkpoint ? "written" : `not written: ${e.serverSave.error}`,
				stopSavedMarker: e.loadedWithoutPlugin[1].value?.lab?.marker === report.run,
				pausedAfterStartWithoutPlugin: e.afterStartWithoutPlugin.paused,
				ticksAdvancedWithoutPlugin: e.loadedWithoutPlugin[0].advanced,
				resumedByPluginOnStart: e.resumedByPlugin.value ? true : e.resumedByPlugin.error,
			};
		}
		const c = report.cluster;
		if (c) {
			const transferHold = c.draining?.holds?.some(hold => hold.ref === c.transferId) === true
				&& c.order.drainingWithHold !== null && c.order.transferCompleted !== null
				&& c.order.drainingWithHold < c.order.transferCompleted && c.order.transferCompleted < c.order.paused;
			observation.cluster = {
				phases: c.phaseLog.map(entry => `${entry.atMs}ms ${entry.phase} (${entry.reason})${entry.holds?.length ? ` holds=${entry.holds.map(h => h.reason).join("|")}` : ""}`),
				frozen: c.frozen.map(sample => sample.advanced),
				resumed: c.resumed.map(sample => sample.advanced),
				transferHeldDraining: transferHold,
				transferStatus: c.transferFinal?.map(row => `${row.transferId} ${row.status}`),
				destinationCargoMatches: JSON.stringify(c.destination?.cargo) === JSON.stringify(expectedCargo),
				sourceRemoved: c.sourceAfter?.present === false,
				frozenAfterTransfer: c.frozenAfterTransfer.map(sample => sample.advanced),
				refusal: c.refusal.error ?? c.refusal.value,
				refusedSourceUnchanged: c.refusedAfter.present && !c.refusedAfter.locked && c.refusedAfter.index === c.refusedBefore.index
					&& JSON.stringify(c.refusedAfter.cargo) === JSON.stringify(c.refusedBefore.cargo),
				resumedAgain: c.resumedAgain.map(sample => sample.advanced),
				watchLines: c.watch?.length,
			};
		}
		const k = report.client;
		if (k) {
			observation.client = {
				engineJoinedWhilePaused: k.engineJoined?.paused === true ? `joined at tick ${k.engineJoined.tick} while paused` : k.engineJoined,
				engineTicksWhileJoinedPaused: k.engineWhileJoinedPaused.advanced,
				engineAfterUnpause: k.engineAfterUnpause.map(sample => `${sample.advanced} ticks/${sample.waitedMs} ms, players ${sample.after.value?.players}`),
				pluginJoinResumedMs: k.resumedByJoinAtMs - k.pluginClientStartedAtMs,
				pluginBothRunning: k.bothRunning.map(sample => sample.advanced),
				pausedAgainAfterLeave: k.frozenAfterLeave.map(sample => sample.advanced),
				clientErrors: [...k.engineLog, ...k.pluginLog].filter(line => /desync|error|dropped|timed out/i.test(line)),
			};
		}
		return { verdict: "PASS", observation };
	} });
	save();
	console.log(JSON.stringify({ artifact: file, verdict: report.verdict, error: report.error, cleanup: report.cleanup, observation: report.observation }, null, 2));
});
