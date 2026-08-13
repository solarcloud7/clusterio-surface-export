// coverage — per-class checklist of read+write attributes unknown to the serializer, offline
//
// requires: the vendored scripts/factorio-api-index.json at the current pin (with subclasses),
//           tools/tests/testkit/coverage-ignore.json; a running cluster ONLY when --live is used
// produces: a markdown checklist grouped by class and upstream subclass annotation (Loader,
//           CraftingMachine, ...), each row a read+write attribute whose identifier appears
//           nowhere in module/**/*.lua and which is not on the committed ignore list; --live
//           enriches LuaEntity rows with sample values read off named platforms
// does not: prove a property is LOST — a row is a question ("should we record this?"), not a
//           defect: create_entity sets some attributes implicitly and an equivalent may ride
//           another payload field. Reads no methods, measures no restoration, touches no cluster
//           on the offline path, and refuses to emit anything when the reference filter fails
//           its controls.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadIndex } from "./api-oracle.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = path.join(here, "..", "..", "..",
	"docker", "seed-data", "external_plugins", "surface_export", "module");
const IGNORE_PATH = path.join(here, "coverage-ignore.json");

export const DEFAULT_CLASSES = ["LuaEntity", "LuaItemStack", "LuaInventory", "LuaTrain", "LuaSpacePlatform"];

const ENTITIES_PER_CALL = 4;
const VALUE_CHARS = 120;
const POSITIVE_CONTROLS = ["direction", "energy"];
const NEGATIVE_CONTROL = "zzz_coverage_negative_control_zzz";
const MIN_CORPUS_FILES = 50;
const MIN_CORPUS_IDENTIFIERS = 1000;

export function writableAttributes(className) {
	const index = loadIndex();
	const members = (index.classes || {})[className];
	if (!members) throw new Error(`${className} is not in the vendored API index`);
	return {
		pin: index.application_version,
		attributes: Object.entries(members)
			.filter(([, d]) => d.kind === "attribute" && d.read === true && d.write === true)
			.map(([name, d]) => ({ name, subclasses: Array.isArray(d.subclasses) ? d.subclasses : null }))
			.sort((a, b) => a.name.localeCompare(b.name)),
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

export function loadIgnoreList(identifiers) {
	const index = loadIndex();
	const parsed = JSON.parse(readFileSync(IGNORE_PATH, "utf8"));
	const entries = Array.isArray(parsed.entries) ? parsed.entries : null;
	if (!entries) throw new Error(`${IGNORE_PATH} must carry { entries: [{ class, attribute, reason }] }`);
	const stale = [];
	for (const entry of entries) {
		if (typeof entry.class !== "string" || typeof entry.attribute !== "string"
			|| typeof entry.reason !== "string" || !entry.reason.trim()) {
			stale.push(`${JSON.stringify(entry)} — every entry needs non-empty class, attribute and reason`);
			continue;
		}
		const member = ((index.classes || {})[entry.class] || {})[entry.attribute];
		if (!member || member.kind !== "attribute" || member.read !== true || member.write !== true) {
			stale.push(`"${entry.class}.${entry.attribute}" is not a read+write attribute at this pin — `
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

export function coverageOffline({ classes = DEFAULT_CLASSES } = {}) {
	const { files, identifiers } = moduleIdentifiers();
	const ignored = loadIgnoreList(identifiers);
	const ignoredSet = new Set(ignored.map(e => `${e.class}.${e.attribute}`));

	let pin = null;
	const byClass = [];
	for (const className of classes) {
		const found = writableAttributes(className);
		pin = found.pin;
		const rows = found.attributes
			.filter(a => !identifiers.has(a.name) && !ignoredSet.has(`${className}.${a.name}`));
		const bySubclass = new Map();
		const universal = [];
		for (const row of rows) {
			if (row.subclasses === null) { universal.push({ attribute: row.name, sample: null, types: null }); continue; }
			const key = row.subclasses.join(", ");
			if (!bySubclass.has(key)) bySubclass.set(key, []);
			bySubclass.get(key).push({ attribute: row.name, sample: null, types: null });
		}
		byClass.push({
			className,
			writable: found.attributes.length,
			universal,
			subclassSections: [...bySubclass.entries()].sort((a, b) => a[0].localeCompare(b[0]))
				.map(([subclass, sectionRows]) => ({ subclass, rows: sectionRows })),
		});
	}

	return {
		mode: "offline", pin, classes,
		filter: { files, identifiers: identifiers.size,
			positiveControls: POSITIVE_CONTROLS, negativeControl: NEGATIVE_CONTROL },
		ignored,
		byClass,
		live: null,
	};
}

function sweepLua(platformIndex, force, targets, attributeNames) {
	const attrList = attributeNames.map(a => `"${a}"`).join(",");
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
      if ok and v ~= nil then
        if type(v) == 'boolean' or type(v) == 'number' then
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

function display(cell) {
	if (cell.kind === "string") return JSON.stringify(cell.v);
	if (cell.kind === "object") return `<${cell.v}>`;
	if (cell.kind === "table") return cell.v;
	return String(cell.v);
}

export async function enrichLive(report, { platforms, host = 1, force = "player", perType = 2 }) {
	if (!Array.isArray(platforms) || platforms.length === 0) {
		throw new Error("enrichLive needs { platforms: [name, ...] }");
	}
	const { lua } = await import("../../../tests/lab-gallery/batch-lifecycle.mjs");
	const { exportInspect, resolvePlatformIndex } = await import("./export-inspect.mjs");

	const entityClass = report.byClass.find(c => c.className === "LuaEntity");
	if (!entityClass) throw new Error("--live enriches LuaEntity rows, but LuaEntity is not in the class scope");
	const allRows = [...entityClass.universal, ...entityClass.subclassSections.flatMap(s => s.rows)];
	const rowByAttr = new Map(allRows.map(r => [r.attribute, r]));
	const attributeNames = [...rowByAttr.keys()].sort();

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
			const answer = lua(host, sweepLua(platformIndex, force, batch, attributeNames));
			if (answer === null || typeof answer !== "object" || answer.success !== true) {
				throw new Error(`live sweep failed: ${answer && answer.error ? answer.error : JSON.stringify(answer)}`);
			}
			const rows = Array.isArray(answer.rows) ? answer.rows : Object.values(answer.rows || {});
			if (rows.length !== batch.length) {
				throw new Error(`live sweep returned ${rows.length} rows for a batch of ${batch.length} — the `
					+ "sweep and the payload disagree about which entities exist, so no verdict is safe");
			}
			for (const row of rows) {
				if (row.missing) { entitiesNotFoundLive += 1; continue; }
				for (const [attribute, cell] of Object.entries(row.values || {})) {
					const slot = rowByAttr.get(attribute);
					if (!slot) continue;
					if (slot.types === null) slot.types = [];
					if (!slot.types.includes(row.type)) slot.types.push(row.type);
					if (slot.sample === null) {
						slot.sample = { value: display(cell), at: `${row.name}@${row.x},${row.y}`, platform };
					}
				}
			}
		}
	}
	report.mode = "offline+live";
	report.live = { platforms, host, perType, entitiesSampled, entitiesNotFoundLive };
	return report;
}

export function renderChecklist(report) {
	const lines = [];
	lines.push(`# Property coverage checklist — ${report.mode}, Factorio ${report.pin}`);
	lines.push("");
	lines.push("A row is a question — \"should we record this?\" — not a defect: `create_entity` sets some");
	lines.push("attributes implicitly, and an equivalent may already ride another payload field. Filters:");
	lines.push("read+write at the pin; identifier absent from `module/**/*.lua`; not on the committed");
	lines.push("ignore list. Subclass headings come from the upstream runtime docs.");
	lines.push("");
	lines.push(`Reference filter: ${report.filter.files} files, ${report.filter.identifiers} identifiers; `
		+ `controls green (${report.filter.positiveControls.join("/")} known, negative token unknown).`);
	if (report.live) {
		lines.push(`Live samples: ${report.live.entitiesSampled} entities from ${report.live.platforms.join(", ")}`
			+ (report.live.entitiesNotFoundLive > 0
				? ` (${report.live.entitiesNotFoundLive} payload entities not found live; excluded)` : "") + ".");
	}
	lines.push("");
	if (report.ignored.length) {
		lines.push("Ignored on purpose:");
		for (const e of report.ignored) lines.push(`- \`${e.class}.${e.attribute}\` — ${e.reason}`);
		lines.push("");
	}
	const rowText = r => {
		let text = `- [ ] \`${r.attribute}\``;
		if (r.sample) text += ` — ${r.sample.value} _(${r.sample.at}, ${r.sample.platform})_`;
		else if (r.types && r.types.length === 0) text += " — (nil on all live samples)";
		return text;
	};
	for (const cls of report.byClass) {
		const total = cls.universal.length + cls.subclassSections.reduce((n, s) => n + s.rows.length, 0);
		lines.push(`## ${cls.className} — ${total} of ${cls.writable} read+write attributes unaccounted for`);
		lines.push("");
		if (cls.universal.length) {
			lines.push(`### Universal (no subclass restriction) — ${cls.universal.length}`);
			lines.push("");
			for (const r of cls.universal) lines.push(rowText(r));
			lines.push("");
		}
		for (const section of cls.subclassSections) {
			lines.push(`### ${section.subclass} — ${section.rows.length}`);
			lines.push("");
			for (const r of section.rows) lines.push(rowText(r));
			lines.push("");
		}
	}
	return lines.join("\n");
}

export function summarize(report) {
	const parts = report.byClass.map(cls => {
		const total = cls.universal.length + cls.subclassSections.reduce((n, s) => n + s.rows.length, 0);
		return `${cls.className} ${total}/${cls.writable}`;
	});
	return `${report.mode} @ Factorio ${report.pin}: unaccounted RW attributes — ${parts.join(", ")} `
		+ `(${report.ignored.length} ignored on purpose)`;
}
