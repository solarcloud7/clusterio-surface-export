#!/usr/bin/env node
// requires: a reachable cluster (dev, or a remote named in tools/clusterio/remote-clusters.local.json); a running instance whose surface_export plugin applied its planet policy, or --planet when no policy is applied; the same "instance send-rcon" that tools/clusterio/ctl.mjs gates behind --write
// produces: the chunks within --radius-chunks of 0,0 generated on that planet's surface, the hostile (enemy-force) entities inside that radius destroyed (none with --dry-run), the area charted for the player force, and a JSON report with found, destroyed and remaining counts per entity kind and the free character position near 0,0; exit 3 when hostiles remain or no position exists
// does not: prepare technology or starter inventories, touch other surfaces, remove a demolisher whose body lies outside the radius or its territory, save the game, or authorize running it on a shared or production cluster
import url from "node:url";
import { DEVELOPMENT, withCluster } from "../shared/remote-cluster.mjs";

export const DEFAULT_RADIUS_CHUNKS = 6;
export const MAX_RADIUS_CHUNKS = 16;
export const MAX_COMMAND_BYTES = 3900;
export const EXIT_NOT_READY = 3;

const USAGE = `usage: node tools/surface-export/prepare-world.mjs --instance <name|id> [--cluster dev|<name>] [--radius-chunks ${DEFAULT_RADIUS_CHUNKS}] [--planet <name>] [--dry-run]

Generates the chunks within the radius around 0,0 on the instance's default planet (its applied planet
policy, or --planet when none is applied), destroys the hostile entities there unless --dry-run, checks
for a free character position within 64 tiles of 0,0, charts the area for the player force and prints
a JSON report. Exit 0 when nothing hostile remains and a position exists; ${EXIT_NOT_READY} when hostiles remain
(every dry run that finds some) or no position exists; 1 when the cluster or the game refuses; 2 for usage.`;

export function parseArgs(argv) {
	const options = { cluster: DEVELOPMENT, instance: null, radiusChunks: DEFAULT_RADIUS_CHUNKS, planet: null, dryRun: false, help: false };
	const seen = new Set();
	const take = (name, index) => {
		const value = argv[index];
		if (value === undefined || value.startsWith("-")) throw new Error(`${name} needs a value`);
		return value;
	};
	for (let index = 0; index < argv.length; index++) {
		let [name, value] = argv[index].startsWith("--") && argv[index].includes("=") ? argv[index].split(/=(.*)/s) : [argv[index], undefined];
		if (name === "--help" || name === "-h") { options.help = true; continue; }
		if (name === "--dry-run") { options.dryRun = true; continue; }
		if (!["--cluster", "--instance", "--radius-chunks", "--planet"].includes(name)) throw new Error(`unsupported argument: ${argv[index]}`);
		if (value === undefined) value = take(name, ++index);
		else if (value === "") throw new Error(`${name} needs a value`);
		if (seen.has(name)) throw new Error(`${name} was given more than once`);
		seen.add(name);
		if (name === "--cluster") options.cluster = value;
		else if (name === "--instance") options.instance = value;
		else if (name === "--planet") {
			if (!/^[a-z0-9_-]+$/i.test(value)) throw new Error(`--planet must be a planet prototype name, not ${JSON.stringify(value)}`);
			options.planet = value;
		} else {
			const radius = Number(value);
			if (!Number.isInteger(radius) || radius < 1 || radius > MAX_RADIUS_CHUNKS) {
				throw new Error(`--radius-chunks must be an integer from 1 to ${MAX_RADIUS_CHUNKS}, not ${JSON.stringify(value)}`);
			}
			options.radiusChunks = radius;
		}
	}
	if (!options.help && options.instance === null) throw new Error("--instance is required");
	return options;
}

function command(body) {
	const text = `/sc ${body.replace(/\s*\n\s*/g, " ").trim()}`;
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > MAX_COMMAND_BYTES) throw new Error(`RCON command is ${bytes} bytes; the limit is ${MAX_COMMAND_BYTES}`);
	return text;
}

function resolvePlanet(planet) {
	return `local policy = storage.surface_export_planet_policy
local wanted = ${planet === null ? "nil" : JSON.stringify(planet)}
local name = policy and policy.default_planet
if name and wanted and wanted ~= name then error("the applied planet policy names " .. name .. ", not " .. wanted) end
name = name or wanted
if not name then error("no planet policy is applied on this instance; pass --planet") end
local planet = game.planets[name]
if not planet then error("planet " .. name .. " is not installed") end`;
}

const PRINT = `rcon.print(helpers.table_to_json(ok and result or {success = false, error = tostring(result)}))`;

export function prepareCommand({ radiusChunks, planet = null }) {
	return command(`local ok, result = pcall(function()
${resolvePlanet(planet)}
local surface = planet.surface or planet.create_surface()
surface.request_to_generate_chunks({0, 0}, ${radiusChunks})
surface.force_generate_chunk_requests()
return {success = true, surface = surface.name, planet = name, policyApplied = policy ~= nil, radiusChunks = ${radiusChunks}}
end)
${PRINT}`);
}

export function scanCommand({ radiusChunks, planet = null, dryRun }) {
	const radiusTiles = radiusChunks * 32;
	return command(`local ok, result = pcall(function()
${resolvePlanet(planet)}
local surface = planet.surface
if not surface then error("planet " .. name .. " has no surface") end
local R = ${radiusTiles}
local dry = ${dryRun ? "true" : "false"}
local area = {{-R, -R}, {R, R}}
local function inside(p) return p.x >= -R and p.x <= R and p.y >= -R and p.y <= R end
local kinds = {}
local function row(kind)
kinds[kind] = kinds[kind] or {kind = kind, found = 0, destroyed = 0, remaining = 0, names = {}}
return kinds[kind]
end
local function hit(r, field, label, destroy)
r[field] = r[field] + 1
if field == "found" then r.names[label] = (r.names[label] or 0) + 1 end
local gone = destroy and destroy() and 1 or 0
r.destroyed = r.destroyed + gone
return gone
end
local function scan(field, destroy)
local total, destroyed = 0, 0
for _, e in pairs(surface.find_entities_filtered{area = area, force = "enemy", is_military_target = true}) do
if e.valid and e.type ~= "segment" and e.type ~= "segmented-unit" then
total = total + 1
destroyed = destroyed + hit(row(e.type), field, e.name, destroy and function() return e.destroy() end)
end
end
for _, u in pairs(surface.get_segmented_units()) do
if u.valid and u.force.name == "enemy" then
for _, p in pairs(u.get_body_nodes()) do
if inside(p) then
total = total + 1
destroyed = destroyed + hit(row("segmented-unit"), field, u.prototype.name, destroy and function() u.destroy() return not u.valid end)
break
end
end
end
end
return total, destroyed
end
local foundTotal, destroyedTotal = scan("found", not dry)
local remainingTotal = scan("remaining", false)
local rows = {}
for _, r in pairs(kinds) do rows[#rows + 1] = r end
table.sort(rows, function(a, b) return a.kind < b.kind end)
local free = surface.find_non_colliding_position("character", {0, 0}, 64, 0.5)
if not dry then game.forces.player.chart(surface, area) end
return {success = true, surface = surface.name, planet = name, policyApplied = policy ~= nil, radiusChunks = ${radiusChunks}, radiusTiles = R, dryRun = dry,
foundTotal = foundTotal, destroyedTotal = destroyedTotal, remainingTotal = remainingTotal, kinds = rows,
freePositionNear00 = free and {x = free.x, y = free.y} or false, charted = not dry}
end)
${PRINT}`);
}

export function parseReply(text) {
	const line = String(text).split(/\r?\n/).map(part => part.trim()).filter(Boolean).at(-1) || "";
	let reply;
	try { reply = JSON.parse(line); }
	catch (error) { throw new Error(`the instance replied without JSON: ${line.slice(0, 500) || "(empty)"} (${error.message})`); }
	if (!reply || typeof reply !== "object" || Array.isArray(reply)) throw new Error(`the instance replied with ${line.slice(0, 500)}`);
	if (reply.success !== true) throw new Error(`the game refused: ${reply.error ?? line.slice(0, 500)}`);
	return reply;
}

export function normalizeReport(reply) {
	const kinds = (Array.isArray(reply.kinds) ? reply.kinds : []).map(row => ({
		...row, names: row.names && !Array.isArray(row.names) ? row.names : {},
	}));
	const total = field => kinds.reduce((sum, row) => sum + (Number(row[field]) || 0), 0);
	const position = reply.freePositionNear00;
	return {
		surface: reply.surface, planet: reply.planet, policyApplied: reply.policyApplied === true,
		radiusChunks: reply.radiusChunks, radiusTiles: reply.radiusTiles, dryRun: reply.dryRun === true,
		found: Number.isSafeInteger(reply.foundTotal) ? reply.foundTotal : total("found"),
		destroyed: Number.isSafeInteger(reply.destroyedTotal) ? reply.destroyedTotal : total("destroyed"),
		remaining: Number.isSafeInteger(reply.remainingTotal) ? reply.remainingTotal : total("remaining"),
		kinds,
		freePositionNear00: position && typeof position === "object" && Number.isFinite(position.x) && Number.isFinite(position.y) ? { x: position.x, y: position.y } : null,
		charted: reply.charted === true,
	};
}

export function verdict(report) {
	const reasons = [];
	if (report.remaining > 0) {
		reasons.push(`${report.remaining} hostile entit${report.remaining === 1 ? "y" : "ies"} remain inside ${report.radiusTiles} tiles of 0,0 on ${report.surface}`
			+ (report.dryRun ? " (dry run: nothing was destroyed)" : ""));
	}
	if (!report.freePositionNear00) reasons.push(`no free character position within 64 tiles of 0,0 on ${report.surface}`);
	return reasons;
}

function report(stream, context, error, code) {
	stream.write(`${context}${String(error?.stderr || error?.message || error).trim()}\n`);
	return code;
}

export async function main(argv, { out = process.stdout, err = process.stderr, run = withCluster } = {}) {
	let options;
	try { options = parseArgs(argv); }
	catch (error) { return report(err, `${USAGE}\n\n`, error, 2); }
	if (options.help) { out.write(`${USAGE}\n`); return 0; }
	const { cluster, instance, radiusChunks, planet, dryRun } = options;
	let world;
	try {
		world = await run(cluster, async transport => {
			const send = async body => parseReply(await transport.ctl("instance", "send-rcon", instance, body));
			const prepared = await send(prepareCommand({ radiusChunks, planet }));
			err.write(`${instance} on ${cluster}: surface ${prepared.surface} (planet ${prepared.planet}, ${prepared.policyApplied ? "applied planet policy" : "--planet"}) generated within ${radiusChunks} chunks of 0,0\n`);
			return normalizeReport(await send(scanCommand({ radiusChunks, planet, dryRun })));
		});
	} catch (error) {
		return report(err, `${instance} on ${cluster}: `, error, 1);
	}
	out.write(`${JSON.stringify(world, null, 2)}\n`);
	const reasons = verdict(world);
	if (reasons.length === 0) return 0;
	err.write(`${reasons.map(reason => `NOT READY: ${reason}`).join("\n")}\n`);
	return EXIT_NOT_READY;
}

if (process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url) {
	process.exitCode = await main(process.argv.slice(2));
}
