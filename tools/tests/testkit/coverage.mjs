// coverage — per-entity-type checklist of read+write LuaEntity attributes unknown to the serializer
//
// requires: a running surface-export cluster carrying the named platform(s); the vendored
//           scripts/factorio-api-index.json at the current pin; tools/tests/testkit/coverage-ignore.json
// produces: a markdown checklist grouped by entity type (universal block + per-type blocks), each
//           row a read+write attribute that read successfully on a live entity of that type, whose
//           identifier appears nowhere in module/**/*.lua, and which is not on the committed
//           ignore list; plus a JSON report of the same
// does not: prove a property is LOST — a row is a question ("should we record this?"), not a
//           defect: create_entity sets some attributes implicitly and an equivalent may ride
//           another payload field. Reads no methods, follows no LuaObject references, measures no
//           restoration, and refuses to emit anything when the reference filter fails its controls.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lua } from "../../../tests/lab-gallery/batch-lifecycle.mjs";
import { exportInspect, resolvePlatformIndex } from "./export-inspect.mjs";
import { loadIndex } from "./api-oracle.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = path.join(here, "..", "..", "..",
	"docker", "seed-data", "external_plugins", "surface_export", "module");
const IGNORE_PATH = path.join(here, "coverage-ignore.json");

const ENTITIES_PER_CALL = 4;
const VALUE_CHARS = 120;
const UNIVERSAL_SHARE = 0.9;
const POSITIVE_CONTROLS = ["direction", "energy"];
const NEGATIVE_CONTROL = "zzz_coverage_negative_control_zzz";
const MIN_CORPUS_FILES = 50;
const MIN_CORPUS_IDENTIFIERS = 1000;

export function writableAttributes(className = "LuaEntity") {
	const index = loadIndex();
	const members = (index.classes || {})[className];
	if (!members) throw new Error(`${className} is not in the vendored API index`);
	return {
		pin: index.application_version,
		attributes: Object.entries(members)
			.filter(([, d]) => d.kind === "attribute" && d.read === true && d.write === true)
			.map(([name]) => name)
			.sort(),
	};
}

export function moduleIdentifiers() {
	let files = 0;
	const identifiers = new Set();
	for (const entry of readdirSync(MODULE_ROOT, { recursive: true })) {
		const rel = String(entry);
		if (!rel.endsWith(".lua")) continue;
		files += 1;
		const source = readFileSync(path.join(MODULE_ROOT, rel), "utf8");
		for (const token of source.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []) identifiers.add(token);
	}
	const failures = [];
	if (files < MIN_CORPUS_FILES) failures.push(`corpus holds ${files} .lua files (minimum ${MIN_CORPUS_FILES})`);
	if (identifiers.size < MIN_CORPUS_IDENTIFIERS) {
		failures.push(`corpus holds ${identifiers.size} identifiers (minimum ${MIN_CORPUS_IDENTIFIERS})`);
	}
	for (const name of POSITIVE_CONTROLS) {
		if (!identifiers.has(name)) failures.push(`positive control "${name}" reads as UNKNOWN`);
	}
	if (identifiers.has(NEGATIVE_CONTROL)) failures.push(`negative control "${NEGATIVE_CONTROL}" reads as KNOWN`);
	if (failures.length) {
		throw new Error("reference filter failed its controls — a broken filter floods the checklist "
			+ "exactly like a real gap would, so no checklist is emitted:\n  " + failures.join("\n  "));
	}
	return { files, identifiers };
}

export function loadIgnoreList(identifiers, writable) {
	const parsed = JSON.parse(readFileSync(IGNORE_PATH, "utf8"));
	const entries = Array.isArray(parsed.entries) ? parsed.entries : null;
	if (!entries) throw new Error(`${IGNORE_PATH} must carry { entries: [{ attribute, reason }] }`);
	const writableSet = new Set(writable);
	const stale = [];
	for (const entry of entries) {
		if (typeof entry.attribute !== "string" || typeof entry.reason !== "string" || !entry.reason.trim()) {
			stale.push(`${JSON.stringify(entry)} — every entry needs a non-empty attribute and reason`);
			continue;
		}
		if (!writableSet.has(entry.attribute)) {
			stale.push(`"${entry.attribute}" is not a read+write LuaEntity attribute at this pin — `
				+ "the row it would suppress cannot appear; delete the entry");
		} else if (identifiers.has(entry.attribute)) {
			stale.push(`"${entry.attribute}" is now referenced in module/ — the row it suppressed no `
				+ "longer appears; delete the entry");
		}
	}
	if (stale.length) {
		throw new Error("stale ignore entries — a dead ignore rule can silently suppress a future real "
			+ "row, so the run refuses:\n  " + stale.join("\n  "));
	}
	return entries;
}

function sweepLua(platformIndex, force, targets, attributes) {
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
  if not e then
    row.missing = true
  else
    row.type = e.type
    local vals = {}
    for _, a in ipairs(attrs) do
      local ok, v = pcall(function() return e[a] end)
      if ok then
        if v == nil then
          vals[a] = { kind = 'nil' }
        elseif type(v) == 'boolean' or type(v) == 'number' then
          vals[a] = { kind = type(v), v = v }
        elseif type(v) == 'string' then
          vals[a] = { kind = 'string', v = string.sub(v, 1, ${VALUE_CHARS}) }
        elseif type(v) == 'table' then
          local enc_ok, enc = pcall(helpers.table_to_json, v)
          vals[a] = { kind = 'table', v = enc_ok and string.sub(enc, 1, ${VALUE_CHARS}) or '(unencodable table)' }
        else
          local on_ok, on = pcall(function() return v.object_name end)
          vals[a] = { kind = 'object', v = on_ok and on or 'userdata' }
        end
      end
    end
    row.values = vals
  end
  out[#out + 1] = row
end
return { success = true, rows = out }`;
}

function callSweep(host, platformIndex, force, batch, attributes) {
	const answer = lua(host, sweepLua(platformIndex, force, batch, attributes));
	if (answer === null || typeof answer !== "object" || answer.success !== true) {
		throw new Error(`live sweep failed: ${answer && answer.error ? answer.error : JSON.stringify(answer)}`);
	}
	const rows = Array.isArray(answer.rows) ? answer.rows : Object.values(answer.rows || {});
	if (rows.length !== batch.length) {
		throw new Error(`live sweep returned ${rows.length} rows for a batch of ${batch.length} — the sweep `
			+ "and the payload disagree about which entities exist, so no verdict is safe");
	}
	return rows;
}

function display(cell) {
	if (cell.kind === "string") return JSON.stringify(cell.v);
	if (cell.kind === "object") return `<${cell.v}>`;
	if (cell.kind === "table") return cell.v;
	return String(cell.v);
}

export async function coverage({ platforms, host = 1, force = "player", perType = 2 }) {
	if (!Array.isArray(platforms) || platforms.length === 0) {
		throw new Error("coverage needs { platforms: [name, ...] }");
	}
	const { pin, attributes } = writableAttributes("LuaEntity");
	const { files, identifiers } = moduleIdentifiers();
	const ignored = loadIgnoreList(identifiers, attributes);
	const ignoredSet = new Set(ignored.map(e => e.attribute));

	const perTypeState = new Map();
	let entitiesSampled = 0;
	let entitiesNotFoundLive = 0;

	for (const platform of platforms) {
		const inspector = await exportInspect({ platform, host, force });
		const entities = inspector.entities.filter(e => e && e.name && e.position);
		if (entities.length === 0) throw new Error(`payload for ${platform} carries no positioned entities`);
		const platformIndex = resolvePlatformIndex(host, platform, force);
		const byType = new Map();
		for (const e of entities) {
			const type = e.type || "(untyped)";
			if (!byType.has(type)) byType.set(type, []);
			if (byType.get(type).length < perType) byType.get(type).push(e);
		}
		const sampled = [...byType.values()].flat();
		entitiesSampled += sampled.length;
		for (let i = 0; i < sampled.length; i += ENTITIES_PER_CALL) {
			const batch = sampled.slice(i, i + ENTITIES_PER_CALL);
			for (const row of callSweep(host, platformIndex, force, batch, attributes)) {
				if (row.missing) { entitiesNotFoundLive += 1; continue; }
				const type = row.type || "(untyped)";
				if (!perTypeState.has(type)) perTypeState.set(type, new Map());
				const slotByAttr = perTypeState.get(type);
				for (const attribute of attributes) {
					const cell = row.values ? row.values[attribute] : undefined;
					if (!cell) continue;
					if (!slotByAttr.has(attribute)) slotByAttr.set(attribute, { sample: null });
					const slot = slotByAttr.get(attribute);
					if (slot.sample === null && cell.kind !== "nil") {
						slot.sample = { value: display(cell), at: `${row.name}@${row.x},${row.y}`, platform };
					}
				}
			}
		}
	}

	const typesSampled = perTypeState.size;
	const rowsByAttr = new Map();
	for (const [type, slotByAttr] of perTypeState) {
		for (const [attribute, slot] of slotByAttr) {
			if (identifiers.has(attribute) || ignoredSet.has(attribute)) continue;
			if (!rowsByAttr.has(attribute)) rowsByAttr.set(attribute, []);
			rowsByAttr.get(attribute).push({ type, sample: slot.sample });
		}
	}
	const universal = [];
	const typeRows = new Map();
	for (const [attribute, hits] of [...rowsByAttr.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		if (hits.length >= typesSampled * UNIVERSAL_SHARE) {
			universal.push({ attribute, types: hits.length, sample: hits.find(h => h.sample)?.sample ?? null });
		} else {
			for (const hit of hits) {
				if (!typeRows.has(hit.type)) typeRows.set(hit.type, []);
				typeRows.get(hit.type).push({ attribute, sample: hit.sample });
			}
		}
	}

	return {
		pin, platforms, host, perType,
		filter: {
			files, identifiers: identifiers.size,
			positiveControls: POSITIVE_CONTROLS, negativeControl: NEGATIVE_CONTROL,
		},
		ignored,
		attributesConsidered: attributes.length,
		typesSampled, entitiesSampled, entitiesNotFoundLive,
		universal,
		byType: [...typeRows.entries()].sort((a, b) => a[0].localeCompare(b[0]))
			.map(([type, rows]) => ({ type, rows })),
	};
}

export function renderChecklist(report) {
	const lines = [];
	lines.push(`# Property coverage checklist — ${report.platforms.join(", ")} (Factorio ${report.pin})`);
	lines.push("");
	lines.push("A row is a question — \"should we record this?\" — not a defect: `create_entity` sets some");
	lines.push("attributes implicitly, and an equivalent may already ride another payload field. Filters:");
	lines.push("read+write at the pin; read successfully on a live entity of the type; identifier absent");
	lines.push("from `module/**/*.lua`; not on the committed ignore list.");
	lines.push("");
	lines.push(`Reference filter: ${report.filter.files} files, ${report.filter.identifiers} identifiers; `
		+ `controls green (${report.filter.positiveControls.join("/")} known, negative token unknown).`);
	if (report.entitiesNotFoundLive > 0) {
		lines.push(`WARNING: ${report.entitiesNotFoundLive} payload entities were not found live `
			+ "(the world moved under the export); their rows are excluded.");
	}
	lines.push("");
	if (report.ignored.length) {
		lines.push("Ignored on purpose:");
		for (const e of report.ignored) lines.push(`- \`${e.attribute}\` — ${e.reason}`);
		lines.push("");
	}
	const sampleText = s => (s
		? `${s.value} _(${s.at}, ${s.platform})_`
		: "(nil on all samples — fixture may not exercise it)");
	lines.push(`## Universal — on ≥90% of the ${report.typesSampled} sampled types (${report.universal.length})`);
	lines.push("");
	for (const u of report.universal) lines.push(`- [ ] \`${u.attribute}\` — ${sampleText(u.sample)}`);
	for (const { type, rows } of report.byType) {
		lines.push("");
		lines.push(`## ${type} (${rows.length})`);
		lines.push("");
		for (const r of rows) lines.push(`- [ ] \`${r.attribute}\` — ${sampleText(r.sample)}`);
	}
	lines.push("");
	return lines.join("\n");
}

export function summarize(report) {
	const specific = report.byType.reduce((n, t) => n + t.rows.length, 0);
	return `${report.platforms.join(", ")} @ Factorio ${report.pin}: ${report.attributesConsidered} RW attributes `
		+ `screened over ${report.entitiesSampled} entities across ${report.typesSampled} types → `
		+ `${report.universal.length} universal + ${specific} type-specific checklist rows `
		+ `(${report.ignored.length} ignored on purpose)`;
}
