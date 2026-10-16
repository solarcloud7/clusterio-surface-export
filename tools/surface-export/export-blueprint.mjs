#!/usr/bin/env node
// requires: a reachable cluster (dev, or a remote named in tools/clusterio/remote-clusters.local.json); a running instance with the space platform to export; the same "instance send-rcon" that tools/clusterio/ctl.mjs gates behind --write (the command only reads the platform but writes a temporary string to storage)
// produces: a blueprint string file of the platform made by the game's own create_blueprint (entities with wires, recipes, filters and control behaviour, foundation tiles, modules as requests, the hub schedule when the engine includes it), shifted so the hub sits at 0,0 as import-blueprint expects, and a JSON summary of what the string holds; the temporary string is removed from storage afterwards
// does not: change, pause or lock the platform, export cargo (belt items, chest contents, fuel or fluids), replace Surface Export's transfer export, or authorize running it on a shared or production cluster
import url from "node:url";
import { writeFileSync } from "node:fs";
import { DEVELOPMENT, withCluster } from "../shared/remote-cluster.mjs";
import { decodeBlueprint, encodeBlueprint, summarize, rconCommand } from "./import-blueprint.mjs";

export const READ_CHARS = 3500;
export const STORAGE_KEY = "surfexp_blueprint_export";
const HUB = "space-platform-hub";

const USAGE = `usage: node tools/surface-export/export-blueprint.mjs --instance <name|id> --platform <index|name> --out <file> [--cluster dev|<name>]

Makes a blueprint string of a live space platform with the game's own create_blueprint, shifts it so the hub
sits at 0,0, writes it to --out and prints a JSON summary of entities, tiles, modules and schedules. The
platform is only read. Exit 0 when written; 1 when the cluster or the game refuses; 2 for usage.`;

export function parseArgs(argv) {
	const options = { cluster: DEVELOPMENT, instance: null, platform: null, out: null, help: false };
	const seen = new Set();
	for (let index = 0; index < argv.length; index++) {
		let [name, value] = argv[index].startsWith("--") && argv[index].includes("=") ? argv[index].split(/=(.*)/s) : [argv[index], undefined];
		if (name === "--help" || name === "-h") { options.help = true; continue; }
		if (!["--cluster", "--instance", "--platform", "--out"].includes(name)) throw new Error(`unsupported argument: ${argv[index]}`);
		if (value === undefined) {
			value = argv[++index];
			if (value === undefined || value.startsWith("-")) throw new Error(`${name} needs a value`);
		}
		if (value === "") throw new Error(`${name} needs a value`);
		if (seen.has(name)) throw new Error(`${name} was given more than once`);
		seen.add(name);
		options[name.slice(2)] = value;
	}
	if (options.help) return options;
	for (const required of ["instance", "platform", "out"]) if (options[required] === null) throw new Error(`--${required} is required`);
	return options;
}

const reply = body => `local ok, result = pcall(function()
${body}
end)
rcon.print(helpers.table_to_json(ok and result or {success = false, error = tostring(result)}))`;

export function createCommand({ platform }) {
	const index = /^\d+$/.test(platform) ? Number(platform) : null;
	return rconCommand(reply(`local found
for _, force in pairs(game.forces) do for _, p in pairs(force.platforms) do
if ${index === null ? `p.name == ${JSON.stringify(platform)}` : `p.index == ${index}`} then if found then error("more than one platform matches") end found = p end
end end
if not found or not found.valid then error("no platform matches ${JSON.stringify(platform).slice(1, -1)}") end
local surface = found.surface
if not surface then error("the platform has no surface yet") end
local x0, y0, x1, y1
for _, tile in pairs(surface.find_tiles_filtered{name = {"empty-space", "out-of-map"}, invert = true}) do
local x, y = tile.position.x, tile.position.y
x0, y0, x1, y1 = math.min(x0 or x, x), math.min(y0 or y, y), math.max(x1 or x, x), math.max(y1 or y, y)
end
if not x0 then error("the platform has no foundation") end
local inventory = game.create_inventory(1)
local stack = inventory[1]
stack.set_stack{name = "blueprint"}
stack.create_blueprint{surface = surface, force = found.force, area = {{x0, y0}, {x1 + 1, y1 + 1}}, always_include_tiles = true, include_entities = true, include_modules = true, include_station_names = true, include_trains = true, include_fuel = true}
stack.label = found.name
local text = stack.export_stack()
local entities = #(stack.get_blueprint_entities() or {})
inventory.destroy()
if not text or text == "" then error("export_stack returned nothing") end
storage.${STORAGE_KEY} = text
return {success = true, name = found.name, index = found.index, surface = surface.name, length = #text, entities = entities}`));
}

export function readCommand(start) {
	return rconCommand(reply(`local text = storage.${STORAGE_KEY}
if not text then error("the export string is gone") end
return {success = true, part = string.sub(text, ${start}, ${start + READ_CHARS - 1})}`));
}

export const clearCommand = () => rconCommand(reply(`storage.${STORAGE_KEY} = nil
return {success = true}`));

export function normalizeToHub(json) {
	const bp = json.blueprint;
	const hub = (bp.entities || []).find(entity => entity.name === HUB);
	if (!hub) throw new Error("the exported blueprint has no space-platform-hub");
	const dx = Math.floor(hub.position.x), dy = Math.floor(hub.position.y);
	for (const entity of bp.entities || []) entity.position = { x: entity.position.x - dx, y: entity.position.y - dy };
	for (const tile of bp.tiles || []) tile.position = { x: tile.position.x - dx, y: tile.position.y - dy };
	return { dx, dy };
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

export async function main(argv, { out = process.stdout, err = process.stderr, run = withCluster, write = writeFileSync } = {}) {
	let options;
	try { options = parseArgs(argv); }
	catch (error) { return report(err, `${USAGE}\n\n`, error, 2); }
	if (options.help) { out.write(`${USAGE}\n`); return 0; }
	try {
		const result = await run(options.cluster, async transport => {
			const send = async body => {
				const value = parseReply(await transport.ctl("instance", "send-rcon", options.instance, body));
				if (value.success !== true) throw new Error(`the game refused: ${value.error ?? JSON.stringify(value).slice(0, 500)}`);
				return value;
			};
			const made = await send(createCommand({ platform: options.platform }));
			err.write(`platform ${made.index} "${made.name}" (${made.surface}): ${made.entities} entities, ${made.length} characters; reading in ${Math.ceil(made.length / READ_CHARS)} parts\n`);
			let text = "";
			try {
				for (let start = 1; start <= made.length; start += READ_CHARS) text += (await send(readCommand(start))).part;
			} finally {
				await send(clearCommand()).catch(error => err.write(`could not clear the export state: ${error.message}\n`));
			}
			if (text.length !== made.length) throw new Error(`read ${text.length} of ${made.length} characters`);
			const json = decodeBlueprint(text);
			const shift = normalizeToHub(json);
			write(options.out, `${encodeBlueprint(json)}\n`);
			const summary = summarize(json);
			return { platform: made.name, platformIndex: made.index, out: options.out, shiftedBy: shift, ...summary,
				entityTotal: Object.values(summary.entities).reduce((a, b) => a + b, 0), schedules: (json.blueprint.schedules || []).length, wires: (json.blueprint.wires || []).length };
		});
		out.write(`${JSON.stringify(result, null, 2)}\n`);
		return 0;
	} catch (error) {
		return report(err, `${options.instance} on ${options.cluster}: `, error, 1);
	}
}

if (process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url) {
	process.exitCode = await main(process.argv.slice(2));
}
