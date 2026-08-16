#!/usr/bin/env node
// build-staging — build the one-of-each staging platform, and report what would not place
//
// requires: a running cluster with NO connected players, the vendored universe.json and
//           placement-rules.json, and a source fixture to clone (--source-index)
// produces: oneofeach-staging-v1 on the target instance — hub plus one cell per universe type —
//           and a report naming every placement, every create_entity refusal with the text the
//           engine threw, and every entity that went invalid after the world ticked
// does not: bank anything into docker/seed-data/lab-saves, transfer the platform, touch a
//           protected fixture, abort on a refusal (a refusal is the measurement), or claim a
//           placed entity RESTORES — only a transfer proves that

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { allocate, loadPlacementRules } from "./lattice.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const UNIVERSE = JSON.parse(readFileSync(path.join(here, "universe.json"), "utf8"));

export const PLATFORM_NAME = "oneofeach-fixture-v1";
export const ORIGIN = { x: -6, y: -7 };
export const COLUMNS = 8;
export const ROWS = 12;
export const HUB_CELL = { column: 0, row: 0 };
export const CENSUS_FIELDS = ["type", "name", "x", "y", "outcome"];
export const SEARCH_RADIUS = 16;

const CONTROLLER = "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";
const PLACE_BATCH = 12;

const arg = (name, fallback) => {
	const index = process.argv.indexOf(name);
	return index === -1 ? fallback : process.argv[index + 1];
};

const INSTANCE = arg("--instance", "clusterio-host-1-instance-1");
const SOURCE_INDEX = Number(arg("--source-index", "21"));
const REPORT_PATH = arg("--report", null);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const jlit = value => JSON.stringify(value).replace(/'/g, "\\'");

function rcon(command, timeout = 300_000) {
	return execFileSync("docker", ["exec", CONTROLLER, "npx", "clusterioctl", "--log-level", "error",
		"instance", "send-rcon", INSTANCE, command, "--config", CTL_CONFIG],
	{ encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 }).trim();
}

function lua(body, timeout = 300_000) {
	const command = `/sc local ok,result=pcall(function() ${body} end) `
		+ "if ok then rcon.print(helpers.table_to_json(result)) "
		+ "else rcon.print(helpers.table_to_json({error=tostring(result)})) end";
	const raw = rcon(command, timeout).split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) || "";
	let parsed;
	try { parsed = JSON.parse(raw); }
	catch (error) { throw new Error(`unparseable Lua JSON (${error.message}): ${raw.slice(0, 400)}`); }
	if (parsed && parsed.error) throw new Error(`Lua refused: ${parsed.error}`);
	return parsed;
}

const PLATFORM = `local plat for _,p in pairs(game.forces.player.platforms) do `
	+ `if p.valid and p.name=='${PLATFORM_NAME}' then plat=p end end `
	+ `if not plat then error('${PLATFORM_NAME} is not on this instance') end local s=plat.surface `;

export function outwardDirection(cell, columns, rows) {
	if (cell.row === rows - 1) return "south";
	if (cell.row === 0) return "north";
	if (cell.column === 0) return "west";
	if (cell.column === columns - 1) return "east";
	throw new Error(`cell ${cell.column},${cell.row} is interior — it faces nothing outward`);
}

export const LITERAL_DIRECTIONS = ["north", "south"];

export function specFor(placement, rules) {
	const rule = placement.rule || {};
	const spec = { t: placement.type, n: placement.name, x: placement.position.x, y: placement.position.y };
	if (rule.direction === "outward") spec.dir = outwardDirection(placement.cell, COLUMNS, ROWS);
	else if (LITERAL_DIRECTIONS.includes(rule.direction)) spec.dir = rule.direction;
	else if (rule.direction) {
		throw new Error(`placement rule for ${placement.type} names direction "${rule.direction}", which the `
			+ "generator does not implement — an unenumerated direction would silently place unrotated");
	}
	if (rule.inner_name) spec.inner = rule.inner_name;
	if (rule.inventory_size) spec.invsize = rule.inventory_size;
	if (rule.stock) spec.stock = rule.stock;
	if (freezes(rules, placement.type)) spec.freeze = 1;
	if (rule.on_type) spec.on_type = rule.on_type;
	if (rule.target_type) {
		spec.target_type = rule.target_type;
		spec.mod = rules.rules[placement.type].module_request;
	}
	return spec;
}

export function freezes(rules, type) {
	return (rules.freeze?.types || []).includes(type);
}

export function specsFor(placement, rules) {
	const spec = specFor(placement, rules);
	const segment = placement.rule?.segment;
	if (!segment) return [spec];
	const span = (segment.count - 1) * segment.pitch;
	return Array.from({ length: segment.count }, (_, index) => ({
		...spec, y: spec.y - span / 2 + index * segment.pitch,
	}));
}

export function partitionSpecs(placements, rules) {
	const specs = placements.flatMap(placement => specsFor(placement, rules));
	const deferred = spec => Boolean(spec.target_type || spec.on_type);
	return {
		first: specs.filter(spec => !deferred(spec)),
		afterTargets: specs.filter(deferred),
	};
}

export function resolveAgainstPlaced(spec, placedFirst) {
	const wanted = spec.target_type || spec.on_type;
	const candidates = placedFirst.filter(row => row.t === wanted && row.placed);
	if (!candidates.length) return { ...spec, tn: " ", tx: 0, ty: 0 };
	const anchor = candidates[Math.floor((candidates.length - 1) / 2)];
	return { ...spec, tn: anchor.n, tx: anchor.px, ty: anchor.py };
}

export function censusRow(entity) {
	return CENSUS_FIELDS.map(field => `${field}=${entity[field]}`).join("|");
}

export function censusHash(rows) {
	const canonical = rows.map(censusRow).sort();
	return { hash: createHash("sha256").update(canonical.join("\n")).digest("hex"), rows: canonical.length };
}

const PLACE_LUA = `${PLATFORM}
	local specs=helpers.json_to_table(__SPECS__)
	local out={}
	for _,sp in pairs(specs) do
		local rec={t=sp.t,n=sp.n}
		local params={name=sp.n, position={sp.x,sp.y}, force='player'}
		if sp.inner then params.inner_name=sp.inner end
		if sp.invsize then params.inventory_size=sp.invsize end
		if sp.on_type then
			local under=s.find_entities_filtered{area={{sp.tx-0.6,sp.ty-0.6},{sp.tx+0.6,sp.ty+0.6}}, name=sp.tn}[1]
			if not under then rec.reason='no '..tostring(sp.tn)..' was on the surface to sit on'
			else params.position={sp.tx,sp.ty} end
		end
		if sp.target_type then
			local tgt=s.find_entities_filtered{area={{sp.tx-0.6,sp.ty-0.6},{sp.tx+0.6,sp.ty+0.6}}, name=sp.tn}[1]
			if not tgt then rec.reason='target '..tostring(sp.tn)..' was not on the surface to attach to'
			else
				params.target=tgt
				params.position={sp.tx,sp.ty}
				params.modules={{id={name=sp.mod.item}, items={in_inventory={{inventory=defines.inventory[sp.mod.inventory], stack=0, count=sp.mod.count}}}}}
			end
		end
		if not rec.reason then
			if sp.dir then params.direction=defines.direction[sp.dir] end
			local ok,res=pcall(function() return s.create_entity(params) end)
			if not ok and sp.dir then
				rec.fallback='direction '..sp.dir..' refused: '..string.sub(tostring(res),1,160)
				params.direction=nil
				ok,res=pcall(function() return s.create_entity(params) end)
			end
			if not ok then rec.reason=string.sub(tostring(res),1,240)
			elseif res==nil then
				local okc,cres=pcall(function() return s.can_place_entity{name=sp.n, position=params.position,
					force='player', direction=params.direction} end)
				rec.reason='create_entity returned nil without throwing; can_place_entity='
					..(okc and tostring(cres) or 'threw '..string.sub(tostring(cres),1,120))
			else rec.placed=true rec.valid=(res.valid==true)
				if res.valid then rec.px=res.position.x rec.py=res.position.y rec.rt=res.type
					rec.un=res.unit_number
					if sp.stock then
						local inv=res.get_inventory(defines.inventory[sp.stock.inventory])
						if not inv then rec.stock_failed='no '..sp.stock.inventory..' inventory on the placed entity'
						else rec.stocked=inv.insert({name=sp.stock.item, count=sp.stock.count}) end
					end
					if sp.freeze then
						pcall(function() res.destructible=false end)
						rec.destructible=res.destructible
						rec.force=res.force.name
						local dok,derr=pcall(function() res.disabled_by_script=true end)
						local dread=nil
						if dok then local rok,rv=pcall(function() return res.disabled_by_script end)
							if rok then dread=rv end end
						local sok,su=pcall(function() return res.segmented_unit end)
						if dok and dread==true then
							rec.freeze_lever='disabled_by_script'
							rec.frozen=true
						elseif sok and su then
							local asleep=defines.segmented_unit_activity_mode.asleep
							local mok=pcall(function() su.minimum_activity_mode=asleep end)
							local aok=pcall(function() su.activity_mode=asleep end)
							local mode=su.activity_mode
							rec.freeze_lever='segmented_unit.activity_mode'
							rec.frozen=(mok and aok and mode==asleep)
							rec.freeze_detail='minimum_write='..tostring(mok)..' mode_write='..tostring(aok)
								..' mode_read_back='..tostring(mode)
						else
							rec.freeze_lever='disabled_by_script'
							rec.frozen=false
							rec.freeze_detail='write='..tostring(dok)..' read_back='..tostring(dread)
								..' err='..string.sub(tostring(derr),1,90)
						end
					end
				end
			end
		end
		out[#out+1]=rec
	end
	return out`;

const RESCAN_LUA = `${PLATFORM}
	local specs=helpers.json_to_table(__SPECS__)
	local byun={}
	for _,e in pairs(s.find_entities_filtered{}) do if e.valid and e.unit_number then byun[e.unit_number]=e end end
	local out={}
	for _,sp in pairs(specs) do
		local rec={t=sp.t,n=sp.n}
		if sp.un then
			local e=byun[sp.un]
			rec.method='unit_number_over_surface_scan'
			rec.alive=(e~=nil and e.valid==true)
			if rec.alive then rec.moved=(math.abs(e.position.x-sp.x)>0.01 or math.abs(e.position.y-sp.y)>0.01) end
		else
			local found=s.find_entities_filtered{area={{sp.x-${SEARCH_RADIUS},sp.y-${SEARCH_RADIUS}},
				{sp.x+${SEARCH_RADIUS},sp.y+${SEARCH_RADIUS}}}, name=sp.n}[1]
			rec.method='name_within_${SEARCH_RADIUS}_tiles'
			rec.alive=(found~=nil and found.valid==true)
		end
		out[#out+1]=rec
	end
	return out`;

async function batched(specs, template, timeout = 300_000) {
	const results = [];
	for (let i = 0; i < specs.length; i += PLACE_BATCH) {
		const slice = specs.slice(i, i + PLACE_BATCH);
		const body = template.replace("__SPECS__", `'${jlit(slice)}'`).replace(/\n\t*/g, " ");
		results.push(...lua(body, timeout));
	}
	return results;
}

async function main() {
	const rules = loadPlacementRules();
	const provided = UNIVERSE.entries.filter(entry => rules.rules[entry.type]?.provided_by);
	const toPlace = UNIVERSE.entries.filter(entry => !rules.rules[entry.type]?.provided_by);

	const { placements, unplaced } = allocate({
		entries: toPlace, columns: COLUMNS, rows: ROWS, origin: ORIGIN, reserved: [HUB_CELL], rules,
	});
	if (unplaced.length) {
		throw new Error(`the lattice could not seat ${unplaced.length} entr(ies): `
			+ unplaced.map(row => row.reason).join("; "));
	}

	const preflight = lua("return {players=#game.connected_players, tick=game.tick, "
		+ "paused=game.tick_paused}");
	if (preflight.players > 0) {
		throw new Error(`${preflight.players} player(s) are connected — a generation run tears down and `
			+ "rebuilds a platform, which would evacuate them mid-session");
	}
	console.log(`preflight: 0 players, tick ${preflight.tick}, paused=${preflight.paused}`);

	const removal = lua(`local n=0 for _,p in pairs(game.forces.player.platforms) do `
		+ `if p.valid and p.name=='${PLATFORM_NAME}' and p.surface and p.surface.valid then `
		+ "game.delete_surface(p.surface) n=n+1 end end return {deleted=n}");
	console.log(`deleted ${removal.deleted} prior ${PLATFORM_NAME} platform(s)`);
	if (removal.deleted > 0) await sleep(4000);

	const clone = lua(`return remote.call('surface_export','clone_platform',${SOURCE_INDEX},'${PLATFORM_NAME}')`);
	if (!clone.success) throw new Error(`clone refused: ${clone.error || JSON.stringify(clone)}`);
	console.log(`cloning fixture ${SOURCE_INDEX} (${clone.source_platform}, ${clone.entity_count} entities) ...`);

	let arrived = false;
	for (let attempt = 0; attempt < 60 && !arrived; attempt++) {
		await sleep(3000);
		arrived = lua(`local n=0 for _,p in pairs(game.forces.player.platforms) do `
			+ `if p.valid and p.name=='${PLATFORM_NAME}' and p.surface then n=1 end end return {ready=n}`).ready === 1;
	}
	if (!arrived) throw new Error(`${PLATFORM_NAME} never appeared after the clone`);

	const x1 = ORIGIN.x + COLUMNS * 28 - 1;
	const y1 = ORIGIN.y + ROWS * 14 - 1;
	const strip = lua(`${PLATFORM}
		local removed=0
		for _,e in pairs(s.find_entities_filtered{}) do
			if e.valid and e.type~='space-platform-hub' then
				local ok=pcall(function() e.destroy({raise_destroy=false}) end)
				if ok then removed=removed+1 end
			end
		end
		local clear={}
		for _,t in pairs(s.find_tiles_filtered{}) do
			local x,y=t.position.x,t.position.y
			if t.name~='empty-space' and (x<${ORIGIN.x} or x>${x1} or y<${ORIGIN.y} or y>${y1}) then
				clear[#clear+1]={name='empty-space',position={x,y}}
			end
		end
		if #clear>0 then s.set_tiles(clear) end
		s.ignore_surface_conditions=true
		local left={}
		for _,e in pairs(s.find_entities_filtered{}) do left[e.type]=(left[e.type] or 0)+1 end
		local tn={}
		for _,t in pairs(s.find_tiles_filtered{}) do if t.name~='empty-space' then tn[t.name]=(tn[t.name] or 0)+1 end end
		return {removed=removed, cleared=#clear, entities_left=left, tiles_left=tn,
			ignore=s.ignore_surface_conditions}`.replace(/\n\t*/g, " "));
	console.log(`stripped: removed ${strip.removed} entities, cleared ${strip.cleared} tiles outside the `
		+ `lattice rectangle, ignore_surface_conditions=${strip.ignore}`);
	console.log(`  entities remaining: ${JSON.stringify(strip.entities_left)}`);
	console.log(`  non-empty tiles remaining anywhere (all inside the rectangle, about to be overwritten `
		+ `by foundation): ${JSON.stringify(strip.tiles_left)}`);

	const band = 24;
	let laid = 0;
	for (let y = ORIGIN.y; y <= y1; y += band) {
		const yEnd = Math.min(y + band - 1, y1);
		const result = lua(`${PLATFORM} local t={} for x=${ORIGIN.x},${x1} do for y=${y},${yEnd} do `
			+ "t[#t+1]={name='space-platform-foundation',position={x,y}} end end s.set_tiles(t) return {n=#t}");
		laid += result.n;
	}
	console.log(`laid ${laid} foundation tiles over the ${COLUMNS}x${ROWS} lattice`);

	const { first, afterTargets } = partitionSpecs(placements, rules);
	const placedFirst = await batched(first, PLACE_LUA);

	const resolved = afterTargets.map(spec => resolveAgainstPlaced(spec, placedFirst));
	const placedAfter = await batched(resolved, PLACE_LUA);
	const results = [...placedFirst, ...placedAfter];

	const settle = lua("return {tick=game.tick}");
	const alive = await batched(
		results.filter(row => row.placed).map(row => ({ t: row.t, n: row.n, x: row.px, y: row.py, un: row.un })),
		RESCAN_LUA);
	const aliveByType = new Map(alive.map(row => [row.t, row]));

	const surface = lua(`${PLATFORM} local out={} for _,e in pairs(s.find_entities_filtered{}) do `
		+ "out[e.type]=(out[e.type] or 0)+1 end "
		+ "local tiles={} for _,t in pairs(s.find_tiles_filtered{}) do "
		+ "if t.name~='empty-space' then tiles[t.name]=(tiles[t.name] or 0)+1 end end "
		+ "return {by_type=out, tiles=tiles}");

	const placementCensus = results.map(row => ({
		type: row.t, name: row.n,
		x: row.placed ? row.px : null, y: row.placed ? row.py : null,
		outcome: row.placed ? "placed" : `refused: ${row.reason}`,
	}));
	const { hash, rows } = censusHash(placementCensus);

	const notPlaced = results.filter(row => !row.placed)
		.map(row => ({ type: row.t, name: row.n, reason: row.reason }));
	const invalidated = results.filter(row => row.placed && aliveByType.get(row.t)?.alive === false)
		.map(row => ({
			type: row.t, name: row.n,
			reason: `created, then absent at the rescan (checked by ${aliveByType.get(row.t).method})`,
		}));
	const wandered = alive.filter(row => row.moved).map(row => row.t);
	const frozen = results.filter(row => row.frozen === true);
	const unfrozen = results.filter(row => row.frozen === false);

	const report = {
		schema: "one-of-each/staging-report@1",
		platform: PLATFORM_NAME,
		instance: INSTANCE,
		source_index: SOURCE_INDEX,
		pin: UNIVERSE.application_version,
		lattice: { origin: ORIGIN, columns: COLUMNS, rows: ROWS, hub_cell: HUB_CELL },
		ticks: { before: preflight.tick, after: settle.tick },
		universe_counts: UNIVERSE.counts,
		provided_by_platform: provided.map(entry => ({ type: entry.type, by: rules.rules[entry.type].provided_by })),
		attempted: results.length,
		placed: results.filter(row => row.placed).map(row => ({
			type: row.t, name: row.n, x: row.px, y: row.py, engine_type: row.rt, fallback: row.fallback || null,
		})),
		not_placed: notPlaced,
		invalidated,
		wandered,
		freeze: {
			policy: rules.freeze,
			applied: frozen.map(row => ({
				type: row.t, lever: row.freeze_lever, destructible: row.destructible, force: row.force,
			})),
			failed: unfrozen.map(row => ({ type: row.t, lever: row.freeze_lever, detail: row.freeze_detail })),
		},
		placement_census: { rows, hash, fields: CENSUS_FIELDS },
		surface_census: surface,
		strip,
	};

	if (REPORT_PATH) writeFileSync(REPORT_PATH, JSON.stringify(report, null, "\t") + "\n");

	console.log(`\n=== ${PLATFORM_NAME}: attempted ${report.attempted}, placed ${report.placed.length}, `
		+ `NOT PLACED ${notPlaced.length}, invalidated ${invalidated.length} ===`);
	for (const row of notPlaced) console.log(`  NOT PLACED  ${row.type} (${row.name}): ${row.reason}`);
	for (const row of invalidated) console.log(`  INVALIDATED ${row.type} (${row.name}): ${row.reason}`);
	for (const row of report.placed.filter(entry => entry.fallback)) {
		console.log(`  FALLBACK    ${row.type}: ${row.fallback}`);
	}
	if (wandered.length) console.log(`  MOVED (alive, not where it was created): ${wandered.join(", ")}`);
	console.log(`froze ${frozen.length}/${rules.freeze.types.length} mobile-or-hostile cell(s) via `
		+ `${[...new Set(frozen.map(row => row.freeze_lever))].join(" + ") || "(none)"}`);
	for (const row of unfrozen) {
		console.log(`  NOT FROZEN  ${row.t} via ${row.freeze_lever}: ${row.freeze_detail}`);
	}
	console.log(`placement census: ${rows} rows, hash ${hash}`);
	console.log(`placement census fields (no identity, no clocks): ${CENSUS_FIELDS.join(", ")}`);
	console.log(`surface census (includes engine progeny, NOT an idempotency artifact): `
		+ `${JSON.stringify(surface.by_type)}`);
	console.log(`surface tiles: ${JSON.stringify(surface.tiles)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
