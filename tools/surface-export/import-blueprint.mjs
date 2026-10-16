#!/usr/bin/env node
// requires: a reachable cluster (dev, or a remote named in tools/clusterio/remote-clusters.local.json); a running instance; a file holding one space-platform blueprint string (a string whose blueprint carries a space-platform-hub); --yes; the same "instance send-rcon" that tools/clusterio/ctl.mjs gates behind --write
// produces: a new, paused space platform at --planet built from the blueprint by the game engine (foundation tiles, entities with their wires, recipes, filters and control behaviour, and requested modules inserted), and a JSON report comparing built entities, tiles and inserted modules with the blueprint; when the blueprint names a newer game version than the instance runs, the version field is lowered to the running version and the report says so; the uploaded string is removed from storage afterwards
// does not: fill belts, chests, fuel or fluids, unpause or schedule-start the platform, transfer or export it, merge into an existing platform, save the game, or authorize running it on a shared or production cluster
import url from "node:url";
import { readFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import { DEVELOPMENT, withCluster } from "../shared/remote-cluster.mjs";

export const MAX_COMMAND_BYTES = 3900;
export const CHUNK_CHARS = 3400;
export const DEFAULT_BATCH = 1500;
export const STORAGE_KEY = "surfexp_blueprint_import";
const HUB = "space-platform-hub";

const USAGE = `usage: node tools/surface-export/import-blueprint.mjs --instance <name|id> --blueprint <file> --yes [--cluster dev|<name>] [--planet nauvis] [--name <platform name>] [--batch ${DEFAULT_BATCH}]

Builds a new, paused space platform at --planet from a space-platform blueprint string, using the game's own
blueprint import and ghost revival, then prints a JSON report of built versus expected entities, tiles and
modules. The platform is structurally complete and empty: no belt items, chest contents, fuel or fluids.
Exit 0 when everything in the blueprint was built; 3 when something is missing; 1 when the cluster or the
game refuses; 2 for usage.`;

export function parseArgs(argv) {
	const options = { cluster: DEVELOPMENT, instance: null, blueprint: null, planet: "nauvis", name: null, batch: DEFAULT_BATCH, yes: false, help: false };
	const seen = new Set();
	for (let index = 0; index < argv.length; index++) {
		let [name, value] = argv[index].startsWith("--") && argv[index].includes("=") ? argv[index].split(/=(.*)/s) : [argv[index], undefined];
		if (name === "--help" || name === "-h") { options.help = true; continue; }
		if (name === "--yes") { options.yes = true; continue; }
		if (!["--cluster", "--instance", "--blueprint", "--planet", "--name", "--batch"].includes(name)) throw new Error(`unsupported argument: ${argv[index]}`);
		if (value === undefined) {
			value = argv[++index];
			if (value === undefined || value.startsWith("-")) throw new Error(`${name} needs a value`);
		}
		if (value === "") throw new Error(`${name} needs a value`);
		if (seen.has(name)) throw new Error(`${name} was given more than once`);
		seen.add(name);
		if (name === "--planet") {
			if (!/^[a-z0-9_-]+$/i.test(value)) throw new Error(`--planet must be a planet prototype name, not ${JSON.stringify(value)}`);
			options.planet = value;
		} else if (name === "--batch") {
			const batch = Number(value);
			if (!Number.isInteger(batch) || batch < 100 || batch > 5000) throw new Error(`--batch must be an integer from 100 to 5000, not ${JSON.stringify(value)}`);
			options.batch = batch;
		} else options[name.slice(2)] = value;
	}
	if (options.help) return options;
	if (options.instance === null) throw new Error("--instance is required");
	if (options.blueprint === null) throw new Error("--blueprint is required");
	if (!options.yes) throw new Error("building a platform changes the game; pass --yes");
	return options;
}

export function decodeBlueprint(text) {
	const trimmed = String(text).trim();
	if (!trimmed.startsWith("0")) throw new Error("not a blueprint string: it must start with the format version 0");
	let json;
	try { json = JSON.parse(inflateSync(Buffer.from(trimmed.slice(1), "base64")).toString("utf8")); }
	catch (error) { throw new Error(`not a blueprint string: ${error.message}`); }
	if (!json.blueprint) throw new Error(`expected one blueprint, got ${Object.keys(json).join(", ") || "nothing"}`);
	return json;
}

export function encodeBlueprint(json) {
	return "0" + deflateSync(Buffer.from(JSON.stringify(json), "utf8"), { level: 9 }).toString("base64");
}

export function versionParts(version) {
	const value = BigInt(version);
	return [48n, 32n, 16n, 0n].map(shift => Number((value >> shift) & 0xffffn));
}

export function versionNumber([major, minor, patch, build = 0]) {
	return Number((BigInt(major) << 48n) | (BigInt(minor) << 32n) | (BigInt(patch) << 16n) | BigInt(build));
}

export function compareVersions(a, b) {
	for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index];
	return 0;
}

export function summarize(json) {
	const bp = json.blueprint;
	const entities = {};
	for (const entity of bp.entities || []) entities[entity.name] = (entities[entity.name] || 0) + 1;
	const tiles = {};
	for (const tile of bp.tiles || []) tiles[tile.name] = (tiles[tile.name] || 0) + 1;
	const modules = {};
	for (const entity of bp.entities || []) {
		for (const request of entity.items || []) {
			const name = request.id?.name ?? request.id;
			const count = (request.items?.in_inventory || []).reduce((sum, slot) => sum + (slot.count || 1), 0);
			modules[name] = (modules[name] || 0) + count;
		}
	}
	return { label: (bp.label || "").trim(), version: versionParts(bp.version).join("."), entities, tiles, requestedItems: modules };
}

export function chunks(text, size = CHUNK_CHARS) {
	const parts = [];
	for (let index = 0; index < text.length; index += size) parts.push(text.slice(index, index + size));
	return parts;
}

export function rconCommand(body) {
	const text = `/sc ${body.replace(/\s*\n\s*/g, " ").trim()}`;
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > MAX_COMMAND_BYTES) throw new Error(`RCON command is ${bytes} bytes; the limit is ${MAX_COMMAND_BYTES}`);
	return text;
}

const reply = body => `local ok, result = pcall(function()
${body}
end)
rcon.print(helpers.table_to_json(ok and result or {success = false, error = tostring(result)}))`;

export const versionCommand = () => rconCommand(reply(`return {success = true, version = script.active_mods.base}`));

export const uploadCommand = (index, part) => {
	if (!/^[A-Za-z0-9+/=]*$/.test(part)) throw new Error("upload chunks must be base64");
	return rconCommand(reply(`${index === 1 ? `storage.${STORAGE_KEY} = {}` : `if not storage.${STORAGE_KEY} then error("upload state was lost; start again") end`}
storage.${STORAGE_KEY}[${index}] = "${part}"
return {success = true, chunk = ${index}}`));
};

export const clearCommand = () => rconCommand(reply(`storage.${STORAGE_KEY} = nil
return {success = true}`));

export function buildCommand({ planet, name, expectedChunks }) {
	return rconCommand(reply(`local parts = storage.${STORAGE_KEY}
if not parts or #parts ~= ${expectedChunks} then error("expected ${expectedChunks} uploaded chunks, found " .. tostring(parts and #parts)) end
local inventory = game.create_inventory(1)
local stack = inventory[1]
local imported = stack.import_stack(table.concat(parts))
storage.${STORAGE_KEY} = nil
if imported ~= 0 or not stack.is_blueprint then inventory.destroy() error("import_stack returned " .. tostring(imported)) end
local planet = game.planets[${JSON.stringify(planet)}]
if not planet then inventory.destroy() error("planet ${planet} is not installed") end
local force = game.forces.player
local platform = force.create_space_platform{name = ${JSON.stringify(name)}, planet = planet.name, starter_pack = "space-platform-starter-pack"}
if not platform then inventory.destroy() error("create_space_platform refused") end
platform.apply_starter_pack()
platform.paused = true
local surface = platform.surface
local hub = platform.hub
local hx, hy = math.floor(hub.position.x), math.floor(hub.position.y)
local tiles = {}
local x0, y0, x1, y1 = hx, hy, hx, hy
for _, tile in pairs(stack.get_blueprint_tiles() or {}) do
local x, y = tile.position.x + hx, tile.position.y + hy
tiles[#tiles + 1] = {name = tile.name, position = {x, y}}
x0, y0, x1, y1 = math.min(x0, x), math.min(y0, y), math.max(x1, x), math.max(y1, y)
end
for cx = math.floor(x0 / 32) - 1, math.floor(x1 / 32) + 1 do for cy = math.floor(y0 / 32) - 1, math.floor(y1 / 32) + 1 do surface.request_to_generate_chunks({cx * 32 + 16, cy * 32 + 16}, 0) end end
surface.force_generate_chunk_requests()
surface.set_tiles(tiles, true, false, true, false)
local min_x, min_y
for _, entity in pairs(stack.get_blueprint_entities() or {}) do
if entity.name ~= "${HUB}" then
min_x = math.min(min_x or entity.position.x, entity.position.x)
min_y = math.min(min_y or entity.position.y, entity.position.y)
end
end
local function place(x, y)
local ghosts = {}
for _, entity in pairs(stack.build_blueprint{surface = surface, force = force, position = {x, y}, build_mode = defines.build_mode.forced, skip_fog_of_war = false}) do
if entity.valid and entity.type == "entity-ghost" then ghosts[#ghosts + 1] = entity end
end
local gx, gy
for _, ghost in pairs(ghosts) do
gx = math.min(gx or ghost.position.x, ghost.position.x)
gy = math.min(gy or ghost.position.y, ghost.position.y)
end
return ghosts, gx and gx - (min_x + hub.position.x) or 0, gy and gy - (min_y + hub.position.y) or 0
end
local ghosts, dx, dy = place(hub.position.x, hub.position.y)
local first = {x = dx, y = dy}
if dx ~= 0 or dy ~= 0 then
for _, ghost in pairs(surface.find_entities_filtered{type = {"entity-ghost", "tile-ghost"}}) do ghost.destroy() end
ghosts, dx, dy = place(hub.position.x - dx, hub.position.y - dy)
end
inventory.destroy()
return {success = true, platformIndex = platform.index, surface = surface.name, hub = hub.position, tilesSet = #tiles, ghosts = #ghosts, firstOffset = first, finalOffset = {x = dx, y = dy}}`));
}

export function reviveCommand({ surface, batch }) {
	return rconCommand(reply(`local surface = game.surfaces[${JSON.stringify(surface)}]
if not surface then error("surface ${surface} is gone") end
local revived, failed = 0, 0
for _, ghost in pairs(surface.find_entities_filtered{type = "entity-ghost", limit = ${batch}}) do
local _, entity = ghost.revive{raise_revive = false}
if entity then revived = revived + 1 else failed = failed + 1 end
end
return {success = true, revived = revived, failed = failed, left = surface.count_entities_filtered{type = "entity-ghost"}}`));
}

export function fulfillCommand({ surface, batch }) {
	return rconCommand(reply(`local surface = game.surfaces[${JSON.stringify(surface)}]
if not surface then error("surface ${surface} is gone") end
local inserted, refused, proxies = 0, 0, 0
for _, proxy in pairs(surface.find_entities_filtered{type = "item-request-proxy", limit = ${batch}}) do
proxies = proxies + 1
local target = proxy.proxy_target
for _, plan in pairs(proxy.insert_plan or {}) do
for _, slot in pairs(plan.items and plan.items.in_inventory or {}) do
local inventory = target and target.valid and target.get_inventory(slot.inventory)
local count = slot.count or 1
if inventory and inventory[slot.stack + 1] and inventory[slot.stack + 1].set_stack{name = plan.id.name, quality = plan.id.quality, count = count} then inserted = inserted + count else refused = refused + count end
end
end
proxy.destroy()
end
return {success = true, proxies = proxies, inserted = inserted, refused = refused, left = surface.count_entities_filtered{type = "item-request-proxy"}}`));
}

export function countCommand({ surface }) {
	return rconCommand(reply(`local surface = game.surfaces[${JSON.stringify(surface)}]
if not surface then error("surface ${surface} is gone") end
local entities, modules = {}, {}
for _, entity in pairs(surface.find_entities_filtered{force = "player"}) do
entities[entity.name] = (entities[entity.name] or 0) + 1
local inventory = entity.get_module_inventory()
if inventory then for index = 1, #inventory do local stack = inventory[index] if stack.valid_for_read then modules[stack.name] = (modules[stack.name] or 0) + stack.count end end end
end
return {success = true, entities = entities, modules = modules, foundation = surface.count_tiles_filtered{name = "space-platform-foundation"},
ghosts = surface.count_entities_filtered{type = "entity-ghost"}, tileGhosts = surface.count_entities_filtered{type = "tile-ghost"}, proxies = surface.count_entities_filtered{type = "item-request-proxy"}}`));
}

export function compare(expected, built) {
	const missing = {};
	const extra = {};
	for (const [name, count] of Object.entries(expected.entities)) {
		const have = built.entities?.[name] || 0;
		if (have < count) missing[name] = count - have;
	}
	for (const [name, count] of Object.entries(built.entities || {})) {
		const want = expected.entities[name] || 0;
		if (count > want) extra[name] = count - want;
	}
	const modulesMissing = {};
	for (const [name, count] of Object.entries(expected.requestedItems)) {
		const have = built.modules?.[name] || 0;
		if (have < count) modulesMissing[name] = count - have;
	}
	const expectedFoundation = expected.tiles["space-platform-foundation"] || 0;
	return { missing, extra, modulesMissing, foundationMissing: Math.max(0, expectedFoundation - (built.foundation || 0)) };
}

function parseReply(text) {
	const lines = String(text).split(/\r?\n/).map(part => part.trim()).filter(line => line.startsWith("{"));
	for (let index = lines.length - 1; index >= 0; index--) {
		try { return JSON.parse(lines[index]); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
	}
	throw new Error(`the instance replied without JSON: ${String(text).trim().slice(0, 500) || "(empty)"}`);
}

function report(stream, context, error, code) {
	stream.write(`${context}${String(error?.stderr || error?.message || error).trim()}\n`);
	return code;
}

export async function main(argv, { out = process.stdout, err = process.stderr, run = withCluster, read = readFileSync, now = Date.now } = {}) {
	let options;
	try { options = parseArgs(argv); }
	catch (error) { return report(err, `${USAGE}\n\n`, error, 2); }
	if (options.help) { out.write(`${USAGE}\n`); return 0; }
	let json;
	try { json = decodeBlueprint(read(options.blueprint, "utf8")); }
	catch (error) { return report(err, "", error, 2); }
	const expected = summarize(json);
	if (!expected.entities[HUB]) { err.write("the blueprint has no space-platform-hub; only space-platform blueprints are supported\n"); return 2; }
	const name = options.name || `${expected.label || "Imported blueprint"} (import)`;
	const log = line => err.write(`${line}\n`);
	try {
		const result = await run(options.cluster, async transport => {
			const send = async body => {
				const value = parseReply(await transport.ctl("instance", "send-rcon", options.instance, body));
				if (value.success !== true) throw new Error(`the game refused: ${value.error ?? JSON.stringify(value).slice(0, 500)}`);
				return value;
			};
			const running = (await send(versionCommand())).version;
			const game = String(running).split(".").map(Number);
			let versionLowered = null;
			if (compareVersions(versionParts(json.blueprint.version), game) > 0) {
				versionLowered = { from: expected.version, to: running };
				json.blueprint.version = versionNumber(game);
				log(`blueprint version ${expected.version} is newer than the game's ${running}; lowered the version field only`);
			}
			const parts = chunks(encodeBlueprint(json));
			log(`uploading ${parts.length} chunks to ${options.instance} on ${options.cluster}`);
			try {
				for (let index = 0; index < parts.length; index++) await send(uploadCommand(index + 1, parts[index]));
				const started = now();
				const built = await send(buildCommand({ planet: options.planet, name, expectedChunks: parts.length }));
				log(`platform ${built.platformIndex} (${built.surface}): ${built.tilesSet} tiles set, ${built.ghosts} ghosts placed, offset ${JSON.stringify(built.finalOffset)}`);
				let revive = { revived: 0, failed: 0, left: built.ghosts };
				let revivedTotal = 0;
				do {
					revive = await send(reviveCommand({ surface: built.surface, batch: options.batch }));
					revivedTotal += revive.revived;
					log(`revived ${revivedTotal}, ${revive.left} ghosts left`);
				} while (revive.revived > 0 && revive.left > 0);
				let fill = { left: 1 };
				const modules = { proxies: 0, inserted: 0, refused: 0 };
				while (fill.left > 0) {
					fill = await send(fulfillCommand({ surface: built.surface, batch: options.batch }));
					for (const key of Object.keys(modules)) modules[key] += fill[key];
					if (fill.proxies === 0) break;
				}
				const buildMs = now() - started;
				const counted = await send(countCommand({ surface: built.surface }));
				return { blueprint: expected.label, version: expected.version, versionLowered, platformIndex: built.platformIndex, surface: built.surface,
					placement: { tilesSet: built.tilesSet, ghostsPlaced: built.ghosts, firstOffset: built.firstOffset, finalOffset: built.finalOffset },
					revived: revivedTotal, ghostsLeft: counted.ghosts, tileGhostsLeft: counted.tileGhosts, modules, buildMs,
					foundation: counted.foundation, ...compare(expected, counted) };
			} finally {
				await send(clearCommand()).catch(error => log(`could not clear the upload state: ${error.message}`));
			}
		});
		out.write(`${JSON.stringify(result, null, 2)}\n`);
		const complete = Object.keys(result.missing).length === 0 && Object.keys(result.modulesMissing).length === 0 && result.foundationMissing === 0 && result.ghostsLeft === 0;
		if (!complete) err.write("INCOMPLETE: the platform is missing entities, modules or tiles from the blueprint\n");
		return complete ? 0 : 3;
	} catch (error) {
		return report(err, `${options.instance} on ${options.cluster}: `, error, 1);
	}
}

if (process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url) {
	process.exitCode = await main(process.argv.slice(2));
}
