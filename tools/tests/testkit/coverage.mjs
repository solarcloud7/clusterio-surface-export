// coverage — which readable LuaEntity attributes have no representative in the export payload?
//
// requires: a running cluster carrying the named platform, and the vendored factorio-api-index.json
// produces: per (prototype type, attribute) a verdict of PRESENT / ABSENT / TRIVIAL / THROWS /
//           UNDECIDABLE, sampled over entities drawn from a real production export
// does not: prove a property is LOST. ABSENT means "this attribute's live value was not found by
//           value-search anywhere in that entity's payload record" — a property can be absent from
//           the payload and still be restored, because create_entity sets it implicitly or it is
//           derived from a field that IS carried. Every ABSENT is a candidate to investigate, never
//           a defect. It also does not read methods, does not follow LuaObject references, and does
//           not measure restoration on a destination.

import { lua } from "../../../tests/lab-gallery/batch-lifecycle.mjs";
import { exportInspect, resolvePlatformIndex } from "./export-inspect.mjs";
import { loadIndex } from "./api-oracle.mjs";

const ENTITIES_PER_CALL = 4;
const VALUE_CHARS = 160;

export function readableAttributes(className = "LuaEntity") {
	const index = loadIndex();
	const members = (index.classes || {})[className];
	if (!members) throw new Error(`${className} is not in the vendored API index`);
	return Object.entries(members)
		.filter(([, d]) => d.kind === "attribute" && d.read === true)
		.map(([name]) => name)
		.sort();
}

// A value only proves presence if a coincidental match is implausible. Booleans, 0/1, empty strings
// and empty tables collide with everything in a payload, so they are reported as UNDECIDABLE rather
// than counted as evidence in either direction.
function entropy(value) {
	if (value === null || value === undefined) return "trivial";
	if (typeof value === "boolean") return "low";
	if (typeof value === "number") return (value === 0 || value === 1) ? "low" : "high";
	if (typeof value === "string") {
		if (value === "" || value === "{}" || value === "[]") return "trivial";
		return value.length >= 3 ? "high" : "low";
	}
	return "low";
}

function payloadValues(record, out = [], depth = 0) {
	if (depth > 8 || record === null || record === undefined) return out;
	if (typeof record !== "object") { out.push(record); return out; }
	for (const value of Object.values(record)) payloadValues(value, out, depth + 1);
	return out;
}

function matchesScalar(live, values) {
	if (typeof live === "number") {
		return values.some(v => typeof v === "number" && Math.abs(v - live) < 1e-9);
	}
	if (typeof live === "string") {
		const needle = live.toLowerCase();
		return values.some(v => typeof v === "string" && v.toLowerCase() === needle)
			|| values.some(v => typeof v === "string" && v.length > 8 && v.toLowerCase().includes(needle));
	}
	return values.some(v => v === live);
}

// A table attribute arrives as a JSON string. Comparing that string against the payload would never
// match, because the payload stores the same information as nested fields with its own key names —
// which is how position, a value the payload demonstrably carries, first showed up as ABSENT. Compare
// the table's leaves instead, and only decide on the ones that carry enough entropy to mean anything.
function matchesTable(encoded, values) {
	let parsed;
	try { parsed = JSON.parse(encoded); } catch { return "undecidable"; }
	const leaves = payloadValues(parsed);
	const decidable = leaves.filter(l => entropy(l) === "high");
	if (decidable.length === 0) return "undecidable";
	return decidable.every(l => matchesScalar(l, values)) ? "present" : "absent";
}

function luaSweep(platformIndex, force, targets, attributes) {
	const attrList = attributes.map(a => `"${a}"`).join(",");
	const targetList = targets
		.map(t => `{name="${t.name}",x=${t.position.x},y=${t.position.y}}`)
		.join(",");
	return `
local attrs = {${attrList}}
local targets = {${targetList}}
local p
for _, pl in pairs(game.forces['${force}'].platforms) do if pl.index == ${platformIndex} then p = pl end end
if not (p and p.valid and p.surface and p.surface.valid) then
  return { success = false, error = 'platform ${platformIndex} has no valid surface' }
end
local s = p.surface
local out = {}
for _, t in ipairs(targets) do
  local ok_find, found = pcall(function()
    return s.find_entities_filtered{ name = t.name, position = { t.x, t.y }, radius = 0.2 }
  end)
  local e = ok_find and found and found[1]
  local row = { name = t.name, x = t.x, y = t.y }
  if not ok_find then
    row.missing = true
    row.reason = 'not an entity prototype name'
  elseif not e then
    row.missing = true
    row.reason = 'no entity at that position'
  else
    row.type = e.type
    local vals, threw = {}, {}
    for _, a in ipairs(attrs) do
      local ok, v = pcall(function() return e[a] end)
      if not ok then
        threw[a] = true
      elseif v == nil then
        vals[a] = { kind = 'nil' }
      elseif type(v) == 'boolean' or type(v) == 'number' then
        vals[a] = { kind = type(v), v = v }
      elseif type(v) == 'string' then
        vals[a] = { kind = 'string', v = string.sub(v, 1, ${VALUE_CHARS}) }
      elseif type(v) == 'table' then
        local enc_ok, enc = pcall(helpers.table_to_json, v)
        vals[a] = { kind = 'table', v = enc_ok and string.sub(enc, 1, ${VALUE_CHARS}) or nil }
      else
        local on_ok, on = pcall(function() return v.object_name end)
        vals[a] = { kind = 'object', v = on_ok and on or 'userdata' }
      end
    end
    row.values = vals
    row.threw = threw
  end
  out[#out + 1] = row
end
return { success = true, rows = out }`;
}

function classify(samples) {
	if (samples.length === 0) return "NO-SAMPLE";
	if (samples.every(s => s === "THROWS")) return "THROWS";
	const decided = samples.filter(s => s !== "THROWS");
	if (decided.every(s => s === "REFERENCE")) return "REFERENCE";
	if (decided.every(s => s === "TRIVIAL")) return "TRIVIAL";
	if (decided.some(s => s === "ABSENT")) return "ABSENT";
	if (decided.some(s => s === "PRESENT")) return "PRESENT";
	return "UNDECIDABLE";
}

export async function coverage({ platform, host = 1, force = "player", perType = 2, only = null }) {
	const attributes = readableAttributes("LuaEntity");
	const inspector = await exportInspect({ platform, host, force });
	const entities = inspector.entities.filter(e => e && e.name && e.position);
	if (entities.length === 0) throw new Error(`payload for ${platform} carries no positioned entities`);

	const byType = new Map();
	for (const e of entities) {
		const type = e.type || "(untyped)";
		if (only && type !== only) continue;
		if (!byType.has(type)) byType.set(type, []);
		if (byType.get(type).length < perType) byType.get(type).push(e);
	}
	const sampled = [...byType.values()].flat();
	if (sampled.length === 0) throw new Error(only ? `no entities of type "${only}" in the payload` : "no samples");

	const platformIndex = resolvePlatformIndex(host, platform, force);

	const rows = [];
	for (let i = 0; i < sampled.length; i += ENTITIES_PER_CALL) {
		const batch = sampled.slice(i, i + ENTITIES_PER_CALL);
		const answer = lua(host, luaSweep(platformIndex, force, batch, attributes));
		if (answer.success !== true) throw new Error(`live sweep failed: ${answer.error ?? JSON.stringify(answer)}`);
		const got = Array.isArray(answer.rows) ? answer.rows : Object.values(answer.rows || {});
		if (got.length !== batch.length) {
			throw new Error(`live sweep returned ${got.length} rows for a batch of ${batch.length} — `
				+ "the sweep and the payload disagree about which entities exist, so no verdict is safe");
		}
		rows.push(...got.map((row, n) => ({ row, record: batch[n] })));
	}

	const verdicts = new Map();
	let missing = 0;
	for (const { row, record } of rows) {
		if (row.missing) { missing++; continue; }
		const values = payloadValues(record);
		const type = row.type || record.type || "(untyped)";
		for (const attribute of attributes) {
			const key = `${type} ${attribute}`;
			if (!verdicts.has(key)) {
				verdicts.set(key, { type, attribute, samples: [], example: null, seen: new Set(), distinct: new Set() });
			}
			const slot = verdicts.get(key);
			if (row.threw?.[attribute]) { slot.samples.push("THROWS"); continue; }
			const cell = row.values?.[attribute];
			if (!cell || cell.kind === "nil" || cell.v === undefined || cell.v === null) {
				slot.samples.push("TRIVIAL");
				continue;
			}
			// A LuaObject reduces to its class name here, so matching it would compare the string
			// "LuaForce" against the payload and call every reference a loss. Following references is
			// option A's job; this screen reports them as out of its reach.
			if (cell.kind === "object") { slot.samples.push("REFERENCE"); continue; }
			slot.seen.add(JSON.stringify([record.name, cell.v]));
			slot.distinct.add(JSON.stringify(cell.v));
			if (cell.kind === "table") {
				const verdict = matchesTable(cell.v, values);
				slot.samples.push(verdict === "undecidable" ? "UNDECIDABLE"
					: verdict === "present" ? "PRESENT" : "ABSENT");
				if (verdict === "absent" && slot.example === null) {
					slot.example = { at: `${row.name}@${row.x},${row.y}`, value: cell.v };
				}
				continue;
			}
			const rank = entropy(cell.v);
			if (rank === "trivial") { slot.samples.push("TRIVIAL"); continue; }
			if (rank === "low") { slot.samples.push("UNDECIDABLE"); continue; }
			if (matchesScalar(cell.v, values)) { slot.samples.push("PRESENT"); continue; }
			slot.samples.push("ABSENT");
			if (slot.example === null) slot.example = { at: `${row.name}@${row.x},${row.y}`, value: cell.v };
		}
	}

	const results = [...verdicts.values()].map(v => ({
		type: v.type, attribute: v.attribute, verdict: classify(v.samples),
		samples: v.samples.length, example: v.example,
		// One value across every entity of this type is weak evidence the attribute is derived from
		// the prototype rather than held per entity. Weak, not proof: two inserters can legitimately
		// agree. It ranks the list; it never decides a verdict.
		constant: v.distinct.size === 1 && v.samples.length > 1,
	}));

	return {
		platform, host, attributesSwept: attributes.length,
		entitiesInPayload: entities.length, entitiesSampled: sampled.length,
		entitiesNotFoundLive: missing,
		types: byType.size,
		results,
	};
}

export function formatCoverage(report) {
	const lines = [];
	const absent = report.results.filter(r => r.verdict === "ABSENT");
	const counts = {};
	for (const r of report.results) counts[r.verdict] = (counts[r.verdict] || 0) + 1;

	lines.push(`platform ${report.platform} (host ${report.host}) — ${report.attributesSwept} readable `
		+ `LuaEntity attributes swept over ${report.entitiesSampled} entities across ${report.types} `
		+ `prototype type(s); payload carries ${report.entitiesInPayload} entities`);
	if (report.entitiesNotFoundLive > 0) {
		lines.push(`  WARNING ${report.entitiesNotFoundLive} payload entit(ies) were not found live — `
			+ "the world moved under the export; those rows are excluded");
	}
	lines.push(`  ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).sort().join("  ")}`);
	lines.push("");

	if (absent.length === 0) {
		lines.push("No ABSENT candidates: every high-entropy attribute value was found in its entity's "
			+ "payload record. That is a screen, not a proof — UNDECIDABLE rows carry values too "
			+ "low-entropy to match either way.");
		return lines.join("\n");
	}

	lines.push(`${absent.length} ABSENT candidate(s) — a live value with no match in the payload record.`);
	lines.push("ABSENT is not a defect: create_entity sets some of these implicitly, and some are derived");
	lines.push("from fields that ARE carried. Each one is a question to answer, not a bug to file.");
	lines.push("");
	const varying = absent.filter(r => !r.constant);
	const constant = absent.filter(r => r.constant);
	lines.push(`  ${varying.length} vary between entities of the same type (investigate first)`);
	lines.push(`  ${constant.length} held one value across every sample — weak evidence they come from`);
	lines.push("  the prototype rather than per-entity state; listed second, not excluded");
	lines.push("");

	for (const [heading, list] of [["VARYING", varying], ["CONSTANT ACROSS SAMPLES", constant]]) {
		if (list.length === 0) continue;
		lines.push(`=== ${heading} ===`);
		const byType = {};
		for (const r of list) (byType[r.type] ||= []).push(r);
		for (const [type, rows] of Object.entries(byType).sort((a, b) => b[1].length - a[1].length)) {
			lines.push(`  ${type}  (${rows.length})`);
			for (const r of rows.sort((a, b) => a.attribute.localeCompare(b.attribute))) {
				const shown = typeof r.example?.value === "string"
					? `"${r.example.value.slice(0, 56)}"` : String(r.example?.value);
				lines.push(`    ${r.attribute.padEnd(36)} ${shown}   ${r.example?.at ?? ""}`);
			}
		}
		lines.push("");
	}
	return lines.join("\n");
}
