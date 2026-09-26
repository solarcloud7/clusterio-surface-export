#!/usr/bin/env node
// requires: Docker with the development controller container (its /clusterio/seed-data/mods holds the mod ZIPs to upload); a desired-state file such as tools/clusterio/desired/vm.json; for a remote cluster, its entry in tools/clusterio/remote-clusters.local.json
// produces: `plan`: the exact clusterioctl commands that bring mods, the mod pack, controller config and instance config to the desired state; `apply --yes`: runs them in order, stops on the first failure and re-plans
// does not: delete stored mods, mod packs or instances, touch mod packs other than the desired one (whose unlisted mods it removes), remove settings, restart instances unless --restart is given, manage gateway links, or authorize a change on a shared cluster
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
			const mod = line.match(/^ {2}(?:[?!] )?(\(disabled\) )?(\S+) (\d+\.\d+\.\d+)(?: \(([0-9a-f]{40})\))?\s*$/);
			if (mod) pack.mods[mod[2]] = { version: mod[3], enabled: !mod[1], sha1: mod[4] };
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

function settingArgs(scope, name, value) {
	const flag = typeof value === "boolean" ? "--bool-setting" : Number.isInteger(value) ? "--int-setting"
		: typeof value === "number" ? "--double-setting" : "--string-setting";
	return [flag, scope, name, String(value)];
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
		modSpecs.push(`${name}:${version}:${file.sha1}`);
		if (!live.mods.has(`${name}_${version}`)) {
			actions.push({ describe: `upload ${name} ${version}`, argv: ["mod", "upload", file.container] });
		}
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
			return !have || have.version !== version || !have.enabled || (hash && have.sha1 && have.sha1 !== hash);
		});
		if (add.length) edit.push("--add-mods", ...add);
		const extra = Object.keys(packDetail.mods).filter(name => !(name in (want.mods || {})));
		if (extra.length) edit.push("--remove-mods", ...extra);
		for (const [scope, values] of Object.entries(want.settings || {})) {
			for (const [name, value] of Object.entries(values)) {
				if (packDetail.settings[scope]?.[name] !== value) edit.push(...settingArgs(scope, name, value));
			}
		}
		if (edit.length) actions.push({ describe: `edit mod pack "${want.name}"`, argv: ["mod-pack", "edit", String(existing.id), ...edit], packChanged: true });
	}

	for (const [field, value] of Object.entries(desired.controller || {})) {
		if (JSON.stringify(live.controller[field]) !== JSON.stringify(value)) {
			actions.push({ describe: `controller ${field}: ${JSON.stringify(live.controller[field])} -> ${JSON.stringify(value)}`,
				argv: ["controller", "config", "set", field, configValue(value)] });
		}
	}

	for (const [instance, fields] of Object.entries(desired.instances || {})) {
		const config = live.instances[instance];
		if (!config) { errors.push(`instance ${instance} does not exist on the cluster`); continue; }
		for (const [field, value] of Object.entries(fields)) {
			if (JSON.stringify(config[field]) !== JSON.stringify(value)) {
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
	return { actions, errors, restart: [...restart], exportNeeded: actions.some(action => action.packChanged) };
}

export function readLive(transport, desired) {
	const packs = parseTable(transport.ctl("mod-pack", "list")).map(row => ({ id: Number(row.id), name: row.name }));
	const packDetails = {};
	const target = packs.find(pack => pack.name === desired.modPack?.name);
	if (target) packDetails[target.id] = parseModPackShow(transport.ctl("mod-pack", "show", String(target.id)));
	const mods = new Set(parseTable(transport.ctl("mod", "list")).map(row => `${row.name}_${row.version}`));
	const controller = parseConfigList(transport.ctl("controller", "config", "list"));
	const instances = {};
	const names = new Set(parseTable(transport.ctl("instance", "list")).map(row => row.name));
	for (const instance of Object.keys(desired.instances || {})) {
		if (names.has(instance)) instances[instance] = parseConfigList(transport.ctl("instance", "config", "list", instance));
	}
	return { packs, packDetails, mods, controller, instances };
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
       node tools/clusterio/reconcile.mjs apply --cluster <dev|name> --desired <file> --yes [--restart]`;

export async function main(argv, { out = process.stdout, err = process.stderr, run = withCluster, read = file => JSON.parse(readFileSync(file, "utf8")) } = {}) {
	const value = flag => { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : undefined; };
	const command = argv[0];
	const cluster = value("--cluster");
	const desiredFile = value("--desired");
	if (!["plan", "apply"].includes(command) || !cluster || !desiredFile) { err.write(`${USAGE}\n`); return 2; }
	if (command === "apply" && !argv.includes("--yes")) { err.write("apply changes the cluster; review `plan` first and pass --yes\n"); return 2; }
	try {
		const desired = read(desiredFile);
		return await run(cluster, transport => {
			const result = planChanges(desired, readLive(transport, desired));
			printPlan(result, out);
			if (command === "plan") return result.errors.length ? 1 : 0;
			if (result.errors.length) { err.write("Refusing to apply a blocked plan.\n"); return 1; }
			for (const action of result.actions) {
				let argvToRun = action.argv;
				if (action.packId) {
					const created = parseTable(transport.ctl("mod-pack", "list")).find(row => row.name === action.packId);
					if (!created) throw new Error(`mod pack "${action.packId}" was not found after creating it`);
					argvToRun = [...action.argv.slice(0, -1), String(created.id)];
				}
				out.write(`applying: ${action.describe}\n`);
				transport.ctl(...argvToRun);
			}
			if (argv.includes("--restart")) {
				for (const instance of result.restart) { out.write(`restarting ${instance}\n`); transport.ctl("instance", "restart", instance); }
			}
			const after = planChanges(desired, readLive(transport, desired));
			out.write(after.actions.length ? `Still different after apply:\n` : "Applied; the cluster now matches the desired state.\n");
			if (after.actions.length) printPlan(after, out);
			return after.actions.length || after.errors.length ? 1 : 0;
		});
	} catch (error) {
		return report(err, error, 1);
	}
}

if (process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url) {
	process.exitCode = await main(process.argv.slice(2));
}
