// snapshot-model — the three-valued cell, the entity pairing key, and the generator for the Lua
// walker both comparator arms run
//
// requires: the vendored scripts/factorio-api-index.json (the readable-attribute roster at the pin)
// produces: buildWalkerLua() — one /sc body that reads every readable attribute of a class off
//           every entity on a surface and writes a snapshot JSON to script-output; plus the cell
//           constructors, the pairing key, and specFingerprint() so the differ can refuse two
//           snapshots that were not taken by the same walker
// does not: run Lua, contact the cluster, truncate a value (long values are hashed whole, by the
//           same Lua in both arms), or decide what a difference MEANS — that is differ.mjs

import { loadIndex } from "../../../tools/tests/testkit/api-oracle.mjs";

export const SNAPSHOT_SCHEMA = "one-of-each/snapshot@1";
export const GENERATOR_VERSION = 1;
export const CELL_STATES = ["PRESENT", "NIL", "THREW"];

export const HASH_THRESHOLD_CHARS = 512;
export const HASH_SEED = 5381;
export const HASH_MULT = 33;
export const HASH_MOD = 4294967296;
export const HASH_PREFIX = "djb2:";

export const POSITION_DECIMALS = 3;
export const NUMBER_FORMAT = "%.17g";
export const MAX_TABLE_DEPTH = 8;

export function hashString(text) {
	let h = HASH_SEED;
	for (let i = 0; i < text.length; i++) h = (h * HASH_MULT + text.charCodeAt(i)) % HASH_MOD;
	return HASH_PREFIX + String(h).padStart(10, "0");
}

export function walkableAttributes(className) {
	const index = loadIndex();
	const members = (index.classes || {})[className];
	if (!members) throw new Error(`${className} is not in the vendored API index`);
	const attributes = Object.entries(members).filter(([, d]) => d.kind === "attribute");
	const readable = attributes.filter(([, d]) => d.read === true).map(([name]) => name).sort();
	if (readable.length === 0) throw new Error(`${className} has no readable attributes — the index lost its flags`);
	return { pin: index.application_version, total: attributes.length, readable };
}

export function positionKey(x, y) {
	return `${Number(x).toFixed(POSITION_DECIMALS)},${Number(y).toFixed(POSITION_DECIMALS)}`;
}

export function entityKey({ name, quality, x, y }) {
	return `${name}|${quality}|${positionKey(x, y)}`;
}

export function cellPresent(value) {
	return { state: "PRESENT", value, hashed: false };
}

export function cellHashed(hash, length) {
	return { state: "PRESENT", value: hash, hashed: true, length };
}

export function cellNil() {
	return { state: "NIL" };
}

export function cellThrew(text) {
	return { state: "THREW", throw: text };
}

export function specFingerprint({ className, attributes }) {
	const spec = [
		`schema=${SNAPSHOT_SCHEMA}`,
		`generator=${GENERATOR_VERSION}`,
		`class=${className}`,
		`hash=${HASH_PREFIX}${HASH_SEED}:${HASH_MULT}:${HASH_MOD}`,
		`threshold=${HASH_THRESHOLD_CHARS}`,
		`number=${NUMBER_FORMAT}`,
		`position=${POSITION_DECIMALS}`,
		`depth=${MAX_TABLE_DEPTH}`,
		`attributes=${attributes.join(",")}`,
	].join("\n");
	return hashString(spec);
}

function luaStringLiteral(text) {
	return `"${String(text).replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n")}"`;
}

export function buildWalkerLua({ className = "LuaEntity", surface, arm, outputFile, attributes } = {}) {
	if (!surface) throw new Error("buildWalkerLua needs a surface name");
	if (!arm) throw new Error("buildWalkerLua needs an arm label — a snapshot with no arm cannot be paired");
	if (!outputFile) throw new Error("buildWalkerLua needs an outputFile");
	const roster = attributes || walkableAttributes(className).readable;
	if (roster.length === 0) throw new Error("refusing to emit a walker with an empty attribute roster");
	const fingerprint = specFingerprint({ className, attributes: roster });

	return `/sc local SURFACE_NAME = ${luaStringLiteral(surface)}
local ARM = ${luaStringLiteral(arm)}
local OUTPUT_FILE = ${luaStringLiteral(outputFile)}
local FINGERPRINT = ${luaStringLiteral(fingerprint)}
local CLASS_NAME = ${luaStringLiteral(className)}
local HASH_THRESHOLD = ${HASH_THRESHOLD_CHARS}
local HASH_SEED = ${HASH_SEED}
local HASH_MULT = ${HASH_MULT}
local HASH_MOD = ${HASH_MOD}
local MAX_DEPTH = ${MAX_TABLE_DEPTH}
local ATTRS = {${roster.map(luaStringLiteral).join(",")}}

local function hash_string(s)
  local h = HASH_SEED
  for i = 1, #s do
    h = (h * HASH_MULT + string.byte(s, i)) % HASH_MOD
  end
  return "${HASH_PREFIX}" .. string.format("%010d", h)
end

local function lua_object_name(v)
  local ok, name = pcall(function() return v.object_name end)
  if ok and type(name) == "string" then return name end
  return nil
end

local function object_key(v, oname)
  local ok_valid, valid = pcall(function() return v.valid end)
  if ok_valid and valid == false then return oname .. "@invalid" end
  local ok_name, name = pcall(function() return v.name end)
  local ok_pos, pos = pcall(function() return v.position end)
  if ok_name and type(name) ~= "string" and name ~= nil then
    local ok_inner, inner = pcall(function() return name.name end)
    name = ok_inner and inner or nil
  end
  if ok_name and name ~= nil and ok_pos and pos ~= nil then
    return string.format("%s@%.${POSITION_DECIMALS}f,%.${POSITION_DECIMALS}f", tostring(name), pos.x, pos.y)
  end
  if ok_name and name ~= nil then return oname .. ":" .. tostring(name) end
  return oname
end

local canon
canon = function(v, depth)
  local t = type(v)
  if v == nil then return "nil" end
  if t == "boolean" then return tostring(v) end
  if t == "number" then return string.format("${NUMBER_FORMAT}", v) end
  if t == "string" then return string.format("%q", v) end
  if t == "function" or t == "thread" then return "<" .. t .. ">" end
  local oname = lua_object_name(v)
  if oname ~= nil then return object_key(v, oname) end
  if t ~= "table" then return "<" .. t .. ">" end
  if depth <= 0 then return "<depth>" end
  local keys = {}
  for k in pairs(v) do keys[#keys + 1] = k end
  table.sort(keys, function(a, b)
    local ta, tb = type(a), type(b)
    if ta ~= tb then return ta < tb end
    if ta == "number" then return a < b end
    return tostring(a) < tostring(b)
  end)
  local parts = {}
  for _, k in ipairs(keys) do
    parts[#parts + 1] = canon(k, depth - 1) .. "=" .. canon(v[k], depth - 1)
  end
  return "{" .. table.concat(parts, ",") .. "}"
end

local function read_cell(entity, attr)
  local ok, value = pcall(function() return entity[attr] end)
  if not ok then return { state = "THREW", throw = tostring(value) } end
  if value == nil then return { state = "NIL" } end
  local ok_canon, text = pcall(function() return canon(value, MAX_DEPTH) end)
  if not ok_canon then return { state = "THREW", throw = tostring(text) } end
  if #text > HASH_THRESHOLD then
    return { state = "PRESENT", value = hash_string(text), hashed = true, length = #text }
  end
  return { state = "PRESENT", value = text, hashed = false }
end

local surface = game.surfaces[SURFACE_NAME]
if surface == nil or not surface.valid then
  rcon.print(helpers.table_to_json({ ok = false, error = "no such surface: " .. SURFACE_NAME }))
  return
end

local entities = surface.find_entities_filtered{}
local rows = {}
for _, entity in pairs(entities) do
  if entity.valid then
    local ok_q, quality = pcall(function() return entity.quality.name end)
    local cells = {}
    for _, attr in ipairs(ATTRS) do
      cells[attr] = read_cell(entity, attr)
    end
    rows[#rows + 1] = {
      key = string.format("%s|%s|%.${POSITION_DECIMALS}f,%.${POSITION_DECIMALS}f", entity.name,
        ok_q and tostring(quality) or "normal", entity.position.x, entity.position.y),
      name = entity.name,
      quality = ok_q and tostring(quality) or "normal",
      etype = entity.type,
      x = entity.position.x,
      y = entity.position.y,
      cells = cells,
    }
  end
end

local snapshot = {
  schema = "${SNAPSHOT_SCHEMA}",
  fingerprint = FINGERPRINT,
  arm = ARM,
  class_name = CLASS_NAME,
  surface = SURFACE_NAME,
  tick = game.tick,
  attributes = ATTRS,
  entities = rows,
}
helpers.write_file(OUTPUT_FILE, helpers.table_to_json(snapshot), false)
rcon.print(helpers.table_to_json({ ok = true, file = OUTPUT_FILE, entities = #rows, attributes = #ATTRS }))`;
}

export function parseSnapshot(raw) {
	const snapshot = typeof raw === "string" ? JSON.parse(raw) : raw;
	if (snapshot.schema !== SNAPSHOT_SCHEMA) {
		throw new Error(`snapshot schema is "${snapshot.schema}", expected "${SNAPSHOT_SCHEMA}"`);
	}
	for (const field of ["fingerprint", "arm", "class_name", "attributes", "entities"]) {
		if (snapshot[field] === undefined) throw new Error(`snapshot is missing "${field}"`);
	}
	if (!Array.isArray(snapshot.entities)) throw new Error("snapshot.entities must be an array");
	for (const entity of snapshot.entities) {
		if (!entity.key) throw new Error("a snapshot entity carries no pairing key");
		for (const [attribute, cell] of Object.entries(entity.cells || {})) {
			if (!CELL_STATES.includes(cell.state)) {
				throw new Error(`${entity.key}.${attribute} has state "${cell.state}", not one of ${CELL_STATES}`);
			}
		}
	}
	return snapshot;
}
