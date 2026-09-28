import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PLUGIN = path.join(ROOT, "docker/seed-data/external_plugins/surface_export");
export const DIST = path.resolve(ROOT, process.env.SE_PLUGIN_DIST || path.join(PLUGIN, "dist/node"));
const quiet = { info() {}, warn() {}, error() {}, verbose() {} };

function loadPlugin() {
	const require = createRequire(import.meta.url);
	const Module = require("node:module");
	const originalLoad = Module._load;
	Module._load = function(request, parent, main) {
		if (request === "@clusterio/lib") {
			class Metric { labels() { return this; } inc() {} observe() {} set() {} }
			const escapeString = value => String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
			return { escapeString, wait: async () => {}, Counter: Metric, Histogram: Metric, Gauge: Metric,
				safeOutputFile: async (file, data) => require("node:fs").promises.writeFile(file, data) };
		}
		if (request === "@clusterio/host") return { BaseInstancePlugin: class {} };
		if (request === "@clusterio/controller") return { BaseControllerPlugin: class {} };
		return originalLoad.call(this, request, parent, main);
	};
	try {
		return {
			...require(path.join(DIST, "instance.js")), ...require(path.join(DIST, "controller.js")),
			...require(path.join(DIST, "lib", "lua-interface.js")), ...require(path.join(DIST, "lib", "source-retirement-journal.js")),
			...require(path.join(DIST, "lib", "lineage-registry.js")), ...require(path.join(DIST, "lib", "transfer-orchestrator.js")),
			messages: require(path.join(DIST, "messages.js")), timing: require(path.join(PLUGIN, "test", "timing-harness.cjs")),
		};
	} finally { Module._load = originalLoad; }
}

class LuaWorld {
	constructor(binary, name) {
		this.name = name;
		this.errors = [];
		this.pending = [];
		this.buffer = "";
		this.process = spawn(binary, ["tests/lua/harness/fake-factorio.lua"], { cwd: ROOT, stdio: ["pipe", "pipe", "inherit"] });
		this.process.stdout.setEncoding("utf8");
		this.process.stdout.on("data", chunk => {
			this.buffer += chunk;
			let newline;
			while ((newline = this.buffer.indexOf("\n")) >= 0) {
				const line = this.buffer.slice(0, newline);
				this.buffer = this.buffer.slice(newline + 1);
				this.pending.shift()?.(JSON.parse(line));
			}
		});
		this.queue = Promise.resolve();
	}

	sendRcon(command) {
		const run = this.queue.then(() => new Promise(resolve => {
			this.pending.push(reply => {
				if (reply.error) {
					this.errors.push(reply.error);
					resolve(`Cannot execute command. Error: ${reply.error}`);
				} else resolve(reply.output);
			});
			this.process.stdin.write(`${JSON.stringify({ command })}\n`);
		}));
		this.queue = run.then(() => undefined, () => undefined);
		return run;
	}

	async eval(expression) {
		const raw = await this.sendRcon(`/sc rcon.print(helpers.table_to_json({value = ${expression}}))`);
		if (raw.startsWith("Cannot execute command")) throw new Error(`${this.name}: ${raw}`);
		return JSON.parse(raw).value;
	}

	close() { this.process.stdin.end(); }
}

export function luaValue(value) {
	return `helpers.json_to_table([==[${JSON.stringify(value)}]==])`;
}

export async function createCluster({ binary, ids = [1, 2], mode = "plugin_history" }) {
	const P = loadPlugin();
	const { messages } = P;
	const dir = mkdtempSync(path.join(os.tmpdir(), "lineage-seams-"));
	const online = new Set(ids);
	const worlds = new Map(), instances = new Map();
	const controller = Object.create(P.ControllerPlugin.prototype);
	const registry = new P.LineageRegistry();
	await registry.load(path.join(dir, "surface_export_lineage_registry.json"));
	const state = { mode };

	async function toInstance(id, message) {
		if (!online.has(id)) throw new Error(`Instance ${id} is offline`);
		const instance = instances.get(id);
		const name = message.constructor.name;
		switch (name) {
			case "LineagePresenceRequest": return instance.handleLineagePresenceRequest(message);
			case "LineageCandidatesRequest": return instance.handleLineageCandidatesRequest(message);
			case "ApplyLineageResolutionRequest": {
				const reply = await instance.handleApplyLineageResolutionRequest(message);
				await collectExports(id);
				return reply;
			}
			case "JobsStatusRequest": return instance.lua.jobStatus(message.jobs);
			case "DeleteSourcePlatformRequest": return instance.handleDeleteSourcePlatform(message);
			case "DestinationTransferGateRequest": return instance.handleDestinationTransferGate(message);
			case "UnlockSourcePlatformRequest": return instance.handleUnlockSourcePlatform(message);
			case "GetSourceTransferLockStateRequest": return instance.handleGetSourceTransferLockState(message);
			case "TransferStatusUpdate": return { success: true };
			case "ImportPlatformRequest": {
				const reply = await worlds.get(id).eval(`harness.import(${luaValue(message.exportData)}, ${JSON.stringify(message.exportData.platform_name || "arrival")})`);
				return reply.success ? { success: true, jobId: reply.jobId, epoch: instance.timingEpoch } : { success: false, error: reply.error };
			}
			default: throw new Error(`Harness has no instance route for ${name}`);
		}
	}

	async function toController(id, message) {
		const name = message.constructor.name;
		if (name === "RecoveryPolicyRequest") return controller.handleRecoveryPolicyRequest(message, { id });
		if (name === "LineageClassifyRequest") return controller.handleLineageClassifyRequest(message, { id });
		if (["OperationTimingEvent", "PlatformStateChangedEvent"].includes(name)) return undefined;
		throw new Error(`Harness has no controller route for ${name}`);
	}

	async function collectExports(id) {
		for (const item of Object.values(await worlds.get(id).eval("harness.take_exports()") || {})) {
			const exportId = `${id}:${item.jobId}`;
			controller.platformStorage.set(exportId, { exportId, sourceExportId: item.jobId, instanceId: id, platformIndex: item.platformIndex,
				platformName: item.platformName, exportData: item.exportData, exportMetrics: null, timestamp: Date.now(), size: 1 });
		}
	}

	Object.assign(controller, {
		logger: quiet,
		controller: {
			config: { get: key => key === "surface_export.platform_source_of_truth" ? state.mode : undefined },
			instances: new Map(ids.map(id => [id, { id, isDeleted: false, config: { get: () => undefined } }])),
			sendTo: (target, message) => toInstance(target.instanceId, message),
		},
		lineageRegistry: registry, pendingTransfers: new Map(), activeTransfers: new Map(), platformStorage: new Map(),
		recoveryReservations: new Map(), persistedTransactionLogs: [], auditIndex: new Map(), transactionLogs: new Map(),
		pendingTransfersLoadError: null, transactionLogLoadError: null,
		txLogger: { ...P.timing.makeTimingHarness(), logTransactionEvent() {}, archiveRecycledTransferId: async () => {}, startPhase() {},
			endPhase: () => 0, persistTransactionLog: async () => {}, buildPhaseSummary: () => ({}) },
		subscriptions: { emitTransferUpdate() {}, queueTreeBroadcast() {} },
		platformTree: { resolveInstanceName: id => `instance-${id}`, resolvePlatformUid: async (_id, _index, _force, uid) => uid },
		persistPendingTransfer(intent) { this.pendingTransfers.set(intent.transferId, intent); },
		persistPendingTransfers: async () => {},
		removePendingTransfer(id) { this.pendingTransfers.delete(id); },
		autoPauseRefusal: async () => null,
		persistStorage: async () => {},
		recordTransferStarted: async () => {},
		isInstanceOnline: id => online.has(id) && !controller.recoveryReservations.has(id),
	});
	controller.orchestrator = new P.TransferOrchestrator(controller, messages);
	controller.resolver = controller.createResolver({ snapshotWaitMs: 2000, pollMs: 10 });

	for (const id of ids) {
		const world = new LuaWorld(binary, `instance ${id}`);
		worlds.set(id, world);
		const instance = Object.create(P.InstancePlugin.prototype);
		instance.logger = quiet;
		instance.instance = { id, config: { get: key => key === "instance.name" ? `Instance ${id}` : undefined },
			sendTo: (_target, message) => toController(id, message) };
		instance.lua = new P.LuaInterface({ sendRcon: command => world.sendRcon(command) }, quiet);
		instance.lua.uploads = { initialize: async () => {}, stop() {} };
		instance.lua.configurePlanetPolicy = async () => {};
		instance.retirementJournal = new P.SourceRetirementJournal(path.join(dir, `journal-${id}.json`));
		await instance.retirementJournal.load();
		instance.boots = 0;
		instances.set(id, instance);
	}

	const cluster = {
		P, messages, controller, registry, worlds, instances, online, dir, state,
		world: id => worlds.get(id),
		async restart(id) {
			const instance = instances.get(id);
			await worlds.get(id).eval("harness.startup()");
			instance.boots += 1;
			instance.timingEpoch = `boot-${id}-${instance.boots}`;
			await instance.reconcileSourceRetirements(instance.timingEpoch);
			return instance.recoveryStatus;
		},
		async load(id, save) {
			const instance = instances.get(id);
			await worlds.get(id).eval(`harness.load(${JSON.stringify(save)})`);
			instance.boots += 1;
			instance.timingEpoch = `boot-${id}-${instance.boots}`;
			await instance.reconcileSourceRetirements(instance.timingEpoch);
			return instance.recoveryStatus;
		},
		save: (id, name) => worlds.get(id).eval(`harness.save(${JSON.stringify(name)})`),
		platform: (id, index, force = "player") => worlds.get(id).eval(`harness.platform(${index}, ${JSON.stringify(force)})`),
		find: (id, name, force = "player") => worlds.get(id).eval(`harness.find(${JSON.stringify(name)}, ${JSON.stringify(force)})`),
		create: (id, name, force = "player", hub = true) => worlds.get(id).eval(`harness.create_platform(${JSON.stringify(name)}, ${JSON.stringify(force)}, ${hub})`),
		async transfer(from, index, to, force = "player") {
			const job = await worlds.get(from).eval(`harness.async.queue_export(${index}, ${JSON.stringify(force)}, "harness", ${to})`);
			if (typeof job !== "string") throw new Error(`export refused on instance ${from}`);
			await collectExports(from);
			const exportId = `${from}:${job}`;
			const started = await controller.orchestrator.transferPlatform(exportId, to);
			for (const transfer of controller.activeTransfers.values()) if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);
			if (!started.success) {
				if (started.safeToUnlockSource) await instances.get(from).lua.unlockPlatform(index, undefined, job);
				return { started, transfer: null };
			}
			await controller.orchestrator.handleTransferValidation({ transferId: started.transferId, platformName: "p", sourceInstanceId: from,
				success: true, validation: { itemCountMatch: true, fluidCountMatch: true } });
			return { started, transfer: controller.activeTransfers.get(started.transferId) };
		},
		async copies(lineage) {
			const found = [];
			for (const [id, world] of worlds) {
				const listed = await world.eval(`(function() local out = {} for fname, force in pairs(game.forces) do for index, p in pairs(force.platforms) do
					local s = harness.platform(index, fname) if s.present and s.lineage == ${JSON.stringify(lineage)} then s.index = index s.force = fname out[#out + 1] = s end end end return out end)()`);
				for (const copy of Object.values(listed || {})) found.push({ instanceId: id, ...copy });
			}
			return found;
		},
		async close() {
			for (const world of worlds.values()) world.close();
			controller.orchestrator.stop();
			rmSync(dir, { recursive: true, force: true });
		},
	};
	try {
		for (const id of ids) await cluster.restart(id);
	} catch (error) {
		await cluster.close();
		throw error;
	}
	return cluster;
}
