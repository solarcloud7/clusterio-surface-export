#!/usr/bin/env node
// requires: Docker with the development controller container (its /clusterio/seed-data/mods holds the mod ZIPs to upload); a desired-state file such as tools/clusterio/desired/vm.json; for a remote cluster, its entry in tools/clusterio/remote-clusters.local.json
// produces: `plan`: the exact clusterioctl commands that bring stored mods, the desired mod pack, controller, host and instance config, and gateway links to the desired state, with blocked items and the instances that need a restart; `apply --yes`: runs them in order, stops at the first failure, re-plans after success, and reports configuration convergence separately from runtime (restart pending, or restarted and running)
// does not: replace a stored mod version, delete stored mods, other mod packs or instances, remove settings, set empty values, restart instances unless --restart is given (and then only running ones), read back what the running games loaded, or authorize a change on a shared cluster
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import { withCluster } from "../shared/remote-cluster.mjs";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const LOCAL_MODS = path.resolve(HERE, "../../docker/seed-data/mods");
const CONTAINER_MODS = "/clusterio/seed-data/mods";
export const BUILTIN_MODS = new Set(["base", "space-age", "quality", "elevated-rails", "recycler"]);

export function parseTable(text) {
	const lines = String(text).split(/\r?\n/).filter(line => line.includes("|"));
	const header = lines.shift()?.split("|").map(cell => cell.trim());
	if (!header?.length) return [];
	return lines.filter(line => !/^[-\s|]+$/.test(line)).map(line => {
		const cells = line.split("|").map(cell => cell.trim());
		return Object.fromEntries(header.map((key, index) => [key, cells[index] ?? ""]));
	});
}

const JSON_LIKE = /^(?:".*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|\[.*\]|\{.*\})$/;

export function parseValue(raw) {
	return JSON_LIKE.test(raw) ? JSON.parse(raw) : raw;
}

export function parseConfigList(text) {
	const config = {};
	for (const line of String(text).split(/\r?\n/)) {
		const match = line.match(/^(\S+) (.*)$/);
		if (match) config[match[1]] = parseValue(match[2]);
	}
	return config;
}

export function parseModPackShow(text) {
	const pack = { mods: {}, settings: {} };
	let section = null;
	let scope = null;
	for (const line of String(text).split(/\r?\n/)) {
		const top = line.match(/^(\w+):\s?(.*)$/);
		if (top) {
			section = top[1];
			if (["id", "name", "factorioVersion", "description"].includes(section)) pack[section] = section === "id" ? Number(top[2]) : top[2];
			continue;
		}
		if (section === "mods") {
			const mod = line.match(/^ {2}(?:([?!]) )?(\(disabled\) )?(\S+) (\d+\.\d+\.\d+)(?: \(([0-9a-f]{40})\))?\s*$/);
			if (mod) {
				const stored = mod[1] === "?" ? "missing" : mod[1] === "!" ? "checksum-mismatch" : "ok";
				pack.mods[mod[3]] = { version: mod[4], enabled: !mod[2], sha1: mod[5], stored };
			}
		} else if (section === "settings") {
			const scopeLine = line.match(/^ {2}([\w-]+):\s*$/);
			if (scopeLine) { scope = scopeLine[1]; pack.settings[scope] = {}; continue; }
			const setting = line.match(/^ {4}(\S+): (.*)$/);
			if (setting && scope) pack.settings[scope][setting[1]] = parseValue(setting[2]);
		}
	}
	return pack;
}

function sha1(file) {
	return createHash("sha1").update(readFileSync(file)).digest("hex");
}

export function localModFile(name, version, { dir = LOCAL_MODS, exists = existsSync, hash = sha1 } = {}) {
	const file = `${name}_${version}.zip`;
	const local = path.join(dir, file);
	if (!exists(local)) return { error: `${file} is not in docker/seed-data/mods; fetch or build it first` };
	return { container: `${CONTAINER_MODS}/${file}`, sha1: hash(local) };
}

const RESTART_CONTROLLER_FIELDS = new Set(["surface_export.gateway_mode", "surface_export.platform_source_of_truth"]);

function settingArgs(scope, name, value) {
	if (value !== null && typeof value === "object") return ["--color-setting", scope, name, JSON.stringify(value)];
	const flag = typeof value === "boolean" ? "--bool-setting" : Number.isInteger(value) ? "--int-setting"
		: typeof value === "number" ? "--double-setting" : "--string-setting";
	return [flag, scope, name, String(value)];
}

function emptyValueError(where, field, value) {
	return value === null || value === ""
		? `${where} ${field}: an empty value cannot be set through clusterioctl (Clusterio turns "" into null); set it deliberately`
		: null;
}

function configValue(value) {
	return typeof value === "string" ? value : JSON.stringify(value);
}

export function planChanges(desired, live, { modFile = localModFile } = {}) {
	const actions = [];
	const errors = [];
	const restart = new Set();
	const want = desired.modPack;
	const existing = live.packs.find(pack => pack.name === want?.name);
	const packDetail = existing ? live.packDetails[existing.id] : null;

	const modSpecs = [];
	for (const [name, version] of Object.entries(want?.mods || {})) {
		if (BUILTIN_MODS.has(name)) { modSpecs.push(`${name}:${version}`); continue; }
		const file = modFile(name, version);
		if (file.error) { errors.push(file.error); continue; }
		const expected = want.sha1?.[name];
		if (expected && expected !== file.sha1) { errors.push(`${name}_${version}.zip sha1 ${file.sha1} does not match the pinned ${expected}`); continue; }
		const storedKey = `${name}_${version}`;
		if (live.mods.has(storedKey)) {
			const stored = live.modSha1?.[storedKey];
			if (!stored) { errors.push(`could not read the stored sha1 of ${name} ${version}; refusing to treat it as matching`); continue; }
			if (stored !== file.sha1) {
				errors.push(`the controller stores ${name} ${version} with sha1 ${stored}, but the local ZIP is ${file.sha1}; `
					+ "a stored version is never replaced: bump the version or delete the stored mod deliberately");
				continue;
			}
		} else {
			actions.push({ describe: `upload ${name} ${version}`, argv: ["mod", "upload", file.container] });
		}
		modSpecs.push(`${name}:${version}:${file.sha1}`);
	}

	if (want && !existing) {
		const settings = Object.entries(want.settings || {}).flatMap(([scope, values]) =>
			Object.entries(values).flatMap(([name, value]) => settingArgs(scope, name, value)));
		actions.push({ describe: `create mod pack "${want.name}" (${want.factorioVersion}, ${modSpecs.length} mods)`,
			argv: ["mod-pack", "create", want.name, want.factorioVersion, "--mods", ...modSpecs, ...settings], packChanged: true });
	} else if (want && packDetail) {
		const edit = [];
		if (packDetail.factorioVersion !== want.factorioVersion) edit.push("--factorio-version", want.factorioVersion);
		const add = modSpecs.filter(spec => {
			const [name, version, hash] = spec.split(":");
			const have = packDetail.mods[name];
			return !have || have.version !== version || !have.enabled || (hash && have.sha1 !== hash);
		});
		if (add.length) edit.push("--add-mods", ...add);
		const extra = Object.keys(packDetail.mods).filter(name => !(name in (want.mods || {})));
		if (extra.length) edit.push("--remove-mods", ...extra);
		for (const [scope, values] of Object.entries(want.settings || {})) {
			for (const [name, value] of Object.entries(values)) {
				if (JSON.stringify(packDetail.settings[scope]?.[name]) !== JSON.stringify(value)) edit.push(...settingArgs(scope, name, value));
			}
		}
		if (edit.length) {
			actions.push({ describe: `edit mod pack "${want.name}"`, argv: ["mod-pack", "edit", String(existing.id), ...edit], packChanged: true });
			for (const [instance, config] of Object.entries(live.instances)) {
				if (instance in (desired.instances || {}) && config["factorio.mod_pack_id"] === existing.id) restart.add(instance);
			}
		}
	}

	for (const [field, value] of Object.entries(desired.controller || {})) {
		if (JSON.stringify(live.controller[field]) !== JSON.stringify(value)) {
			const empty = emptyValueError("controller", field, value);
			if (empty) { errors.push(empty); continue; }
			actions.push({ describe: `controller ${field}: ${JSON.stringify(live.controller[field])} -> ${JSON.stringify(value)}`,
				argv: ["controller", "config", "set", field, configValue(value)] });
			if (RESTART_CONTROLLER_FIELDS.has(field)) {
				for (const instance of Object.keys(desired.instances || {})) if (live.instances[instance]) restart.add(instance);
			}
		}
	}

	for (const [instance, fields] of Object.entries(desired.instances || {})) {
		const config = live.instances[instance];
		if (!config) { errors.push(`instance ${instance} does not exist on the cluster`); continue; }
		for (const [field, value] of Object.entries(fields)) {
			if (JSON.stringify(config[field]) !== JSON.stringify(value)) {
				const empty = emptyValueError(instance, field, value);
				if (empty) { errors.push(empty); continue; }
				actions.push({ describe: `${instance} ${field}: ${JSON.stringify(config[field])} -> ${JSON.stringify(value)}`,
					argv: ["instance", "config", "set", instance, field, configValue(value)] });
				restart.add(instance);
			}
		}
		if (want && desired.instanceModPack !== false) {
			if (!existing) {
				actions.push({ describe: `${instance} factorio.mod_pack_id -> "${want.name}"`, packId: want.name,
					argv: ["instance", "config", "set", instance, "factorio.mod_pack_id", "<id of new pack>"] });
				restart.add(instance);
			} else if (config["factorio.mod_pack_id"] !== existing.id) {
				actions.push({ describe: `${instance} factorio.mod_pack_id: ${config["factorio.mod_pack_id"]} -> ${existing.id} ("${want.name}")`,
					argv: ["instance", "config", "set", instance, "factorio.mod_pack_id", String(existing.id)] });
				restart.add(instance);
			}
		}
	}

	for (const [host, fields] of Object.entries(desired.hosts || {})) {
		const config = live.hosts?.[host];
		if (!config) { errors.push(`host ${host} is not connected, so its config cannot be read`); continue; }
		for (const [field, value] of Object.entries(fields)) {
			if (JSON.stringify(config[field]) !== JSON.stringify(value)) {
				const empty = emptyValueError(host, field, value);
				if (empty) { errors.push(empty); continue; }
				actions.push({ describe: `${host} ${field}: ${JSON.stringify(config[field])} -> ${JSON.stringify(value)}`,
					argv: ["host", "config", "set", host, field, configValue(value)] });
			}
		}
	}

	if (desired.gatewayLinks) {
		const ids = live.instanceIds || {};
		const current = new Map((live.gateways?.links || []).map(link =>
			[`${link.sourceInstanceId}:${link.gatewayName}`, link.targets.map(target => `${target.targetInstanceId}:${target.targetGateway}`).sort().join(",")]));
		for (const [source, gateways] of Object.entries(desired.gatewayLinks)) {
			if (!Number.isInteger(ids[source])) { errors.push(`gateway source ${source} is not an instance on the cluster`); continue; }
			for (const [gatewayName, targets] of Object.entries(gateways)) {
				const unknown = targets.filter(target => !Number.isInteger(ids[target]));
				if (unknown.length) { errors.push(`gateway targets not on the cluster: ${unknown.join(", ")}`); continue; }
				const wanted = targets.map(target => `${ids[target]}:${gatewayName}`).sort().join(",");
				if ((current.get(`${ids[source]}:${gatewayName}`) || "") !== wanted) {
					actions.push({ describe: `${source} ${gatewayName} links -> ${targets.join(", ") || "none"}`,
						argv: ["surface-export", "set-gateway-links", String(ids[source]), gatewayName, ...targets.map(target => String(ids[target]))] });
				}
			}
		}
	}
	return { actions, errors, restart: [...restart], exportNeeded: actions.some(action => action.packChanged) };
}

export function readLive(transport, desired) {
	const packs = parseTable(transport.ctl("mod-pack", "list")).map(row => ({ id: Number(row.id), name: row.name }));
	const packDetails = {};
	const target = packs.find(pack => pack.name === desired.modPack?.name);
	if (target) packDetails[target.id] = parseModPackShow(transport.ctl("mod-pack", "show", String(target.id)));
	const mods = new Set(parseTable(transport.ctl("mod", "list")).map(row => `${row.name}_${row.version}`));
	const modSha1 = {};
	for (const [name, version] of Object.entries(desired.modPack?.mods || {})) {
		const storedKey = `${name}_${version}`;
		if (BUILTIN_MODS.has(name) || !mods.has(storedKey)) continue;
		const sha1Line = transport.ctl("mod", "show", name, version).split(/\r?\n/).find(line => line.startsWith("sha1: "));
		if (sha1Line) modSha1[storedKey] = sha1Line.slice("sha1: ".length).trim();
	}
	const controller = parseConfigList(transport.ctl("controller", "config", "list"));
	const instances = {};
	const instanceRows = parseTable(transport.ctl("instance", "list"));
	const names = new Set(instanceRows.map(row => row.name));
	const instanceIds = Object.fromEntries(instanceRows.map(row => [row.name, Number(row.id)]));
	for (const instance of Object.keys(desired.instances || {})) {
		if (names.has(instance)) instances[instance] = parseConfigList(transport.ctl("instance", "config", "list", instance));
	}
	const hosts = {};
	const connected = new Set(parseTable(transport.ctl("host", "list")).filter(row => row.connected === "true").map(row => row.name));
	for (const host of Object.keys(desired.hosts || {})) {
		if (connected.has(host)) hosts[host] = parseConfigList(transport.ctl("host", "config", "list", host));
	}
	const gateways = desired.gatewayLinks ? JSON.parse(transport.ctl("surface-export", "gateways").trim().split(/\r?\n/).at(-1)) : undefined;
	return { packs, packDetails, mods, modSha1, controller, instances, instanceIds, hosts, gateways };
}

function printPlan(result, out) {
	for (const error of result.errors) out.write(`BLOCKED: ${error}\n`);
	if (!result.actions.length) out.write("No changes: the cluster matches the desired state.\n");
	result.actions.forEach((action, index) => out.write(`${index + 1}. ${action.describe}\n   clusterioctl ${action.argv.map(arg => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(" ")}\n`));
	if (result.restart.length) out.write(`Restart needed for the change to take effect: ${result.restart.join(", ")}\n`);
	if (result.exportNeeded) out.write("After the restart, regenerate item icons: clusterioctl instance export-data <an instance on the pack's export host>\n");
}

function report(stream, error, code) {
	stream.write(`reconcile: ${String(error?.stderr || error?.message || error).trim()}\n`);
	return code;
}

const USAGE = `usage: node tools/clusterio/reconcile.mjs plan --cluster <dev|name> --desired <file>
       node tools/clusterio/reconcile.mjs apply --cluster <dev|name> --desired <file> --yes [--restart]
exit codes: 0 configuration converged and no restart pending, 1 blocked or still different, 2 usage, 4 configuration converged but a restart is pending or an instance is not running`;

export async function main(argv, { out = process.stdout, err = process.stderr, run = withCluster, read = file => JSON.parse(readFileSync(file, "utf8")), modFile = localModFile,
	sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), pollAttempts = 36, pollIntervalMs = 5000 } = {}) {
	const value = flag => { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : undefined; };
	const command = argv[0];
	const cluster = value("--cluster");
	const desiredFile = value("--desired");
	if (!["plan", "apply"].includes(command) || !cluster || !desiredFile) { err.write(`${USAGE}\n`); return 2; }
	if (command === "apply" && !argv.includes("--yes")) { err.write("apply changes the cluster; review `plan` first and pass --yes\n"); return 2; }
	try {
		const desired = read(desiredFile);
		return await run(cluster, async transport => {
			const result = planChanges(desired, readLive(transport, desired), { modFile });
			printPlan(result, out);
			if (command === "plan") return result.errors.length ? 1 : 0;
			if (result.errors.length) { err.write("Refusing to apply a blocked plan.\n"); return 1; }
			for (const action of result.actions) {
				let argvToRun = action.argv;
				if (action.packId) {
					const matches = parseTable(transport.ctl("mod-pack", "list")).filter(row => row.name === action.packId);
					if (matches.length !== 1) throw new Error(`expected exactly one mod pack named "${action.packId}" after creating it, found ${matches.length}`);
					argvToRun = [...action.argv.slice(0, -1), String(matches[0].id)];
				}
				out.write(`applying: ${action.describe}\n`);
				transport.ctl(...argvToRun);
			}
			const after = planChanges(desired, readLive(transport, desired), { modFile });
			if (after.actions.length || after.errors.length) {
				out.write("Configuration: still different after apply.\n");
				printPlan(after, out);
				return 1;
			}
			out.write("Configuration: converged; the controller matches the desired state.\n");
			if (!result.restart.length) { out.write("Runtime: no restart required.\n"); return 0; }
			if (!argv.includes("--restart")) {
				out.write(`Runtime: RESTART REQUIRED for ${result.restart.join(", ")}; the running games still use their previous configuration. Pass --restart or restart them.\n`);
				return 4;
			}
			const notRunning = [];
			for (const instance of result.restart) {
				const before = parseTable(transport.ctl("instance", "list")).find(row => row.name === instance)?.status || "missing";
				if (before !== "running") {
					notRunning.push(`${instance} (${before}; not restarted, it loads the new configuration when started)`);
					continue;
				}
				out.write(`restarting ${instance}\n`);
				transport.ctl("instance", "restart", instance);
				let status = "";
				for (let attempt = 0; attempt < pollAttempts; attempt++) {
					status = parseTable(transport.ctl("instance", "list")).find(row => row.name === instance)?.status || "missing";
					if (status === "running") break;
					await sleep(pollIntervalMs);
				}
				if (status !== "running") notRunning.push(`${instance} (${status})`);
			}
			if (notRunning.length) {
				out.write(`Runtime: restarted, but not running: ${notRunning.join(", ")}.\n`);
				return 4;
			}
			out.write(`Runtime: restarted and running: ${result.restart.join(", ")}. The loaded mods and settings were not read back from the games.\n`);
			return 0;
		});
	} catch (error) {
		return report(err, error, 1);
	}
}

if (process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url) {
	process.exitCode = await main(process.argv.slice(2));
}
