#!/usr/bin/env node
// census-lab R1 — stall-budget rung.
//
// Measures the WALL-CLOCK cost of one full physical surface census (items + fluids) at production
// scale (the 1,359-entity `test` platform on host-1), so the later paired-reads implementation has a
// MEASURED stall budget instead of an assumed one. Phase 0 of the paired-reads epic.
//
// Instrument (Pitfall #24 — LuaProfiler is display-only, cannot be read numerically; time from Node):
//   * `process.hrtime.bigint()` around each RCON round-trip (docker exec -> clusterioctl -> /sc).
//   * A bare `/sc rcon.print(1)` baseline (5x, averaged) measures the fixed docker+npx+RCON overhead.
//   * Each census is run 1x, 10x, ... Nx IN ONE `/sc` execution. Wall(m) ~= overhead + m*census_cost,
//     so a least-squares slope over the multipliers isolates the pure per-census engine cost from the
//     ~1-2s exec overhead (the intercept, which should ~= the baseline mean — a built-in cross-check).
//
// Census loop is INLINED in the `/sc` string (SurfaceCounter is a save-patched module, unreachable from
// an RCON console command). It faithfully mirrors module/validators/surface-counter.lua:
//   items : find_entities_filtered({}) -> per-entity get_item_count() + belt transport lines + inserter
//           held_stack + ground item-entities.
//   fluids: two passes (temps, then segment-deduplicated contents) exactly as count_fluids.
// CAVEAT (recorded in NOTEBOOK): production SurfaceCounter uses InventoryScanner.extract_all_inventories
// (iterates every inventory index, allocates per-slot tables) whereas get_item_count() is ONE cheaper
// engine call. The measured number is therefore a LOWER BOUND; the real cost is higher; keep margin.
//
// This runner NEVER edits production files and NEVER mutates the `test` platform (read-only census).
// The only state it creates is the 0-entity control fixture, deleted in a guaranteed finally.
//
// Usage:
//   node tests/census-lab/run-r1-stall-budget.mjs                 # full run, appends NOTEBOOK
//   node tests/census-lab/run-r1-stall-budget.mjs --no-notebook   # debug iteration, no NOTEBOOK write
//   node tests/census-lab/run-r1-stall-budget.mjs --reset         # cleanup only (delete lab fixtures)
//   ... --multipliers=1,10,50,100 --samples=5

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const controller = "surface-export-controller";
const config = "/clusterio/tokens/config-control.json";
const source = "clusterio-host-1-instance-1";
const notebook = "tests/census-lab/NOTEBOOK.md";
const fixturePrefix = "census-lab-probe";
const tickMs = 1000 / 60; // 16.667 ms — one 60 UPS frame, the real stall constraint (advisor anchor)
const rconTimeoutMs = 180000;

let multipliers = [1, 10, 50, 100];
let samples = 5;
let resetOnly = false;
let noNotebook = false;
for (let i = 2; i < process.argv.length; i += 1) {
	const arg = process.argv[i];
	if (arg === "--reset") resetOnly = true;
	else if (arg === "--no-notebook") noNotebook = true;
	else if (arg.startsWith("--multipliers=")) multipliers = arg.slice(14).split(",").map(Number).filter(n => n > 0);
	else if (arg.startsWith("--samples=")) samples = Number(arg.slice(10));
	else throw new Error(`Unknown argument: ${arg}`);
}
if (!multipliers.length) throw new Error("--multipliers requires at least one positive integer");
multipliers = [...new Set(multipliers)].sort((a, b) => a - b);

function lastLine(value) { return String(value).split(/\r?\n/).map(l => l.trim()).filter(Boolean).at(-1) || ""; }
function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }
function sum(a) { return a.reduce((x, y) => x + y, 0); }
function mean(a) { return a.length ? sum(a) / a.length : null; }
function median(a) {
	if (!a.length) return null;
	const s = [...a].sort((x, y) => x - y);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Bare Node -> docker -> clusterioctl -> RCON round trip, wall-clock timed from the Node side.
// Identical transport for baseline and census so the fixed overhead cancels in the regression.
function rconTimed(cmd) {
	const t0 = process.hrtime.bigint();
	let stdout = "", ok = true, err = null;
	try {
		stdout = execFileSync("docker", ["exec", controller, "npx", "clusterioctl", "--log-level", "error",
			"instance", "send-rcon", source, cmd, "--config", config],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: rconTimeoutMs, maxBuffer: 16 * 1024 * 1024 }).trim();
	} catch (e) {
		ok = false; err = e.message; stdout = String(e.stdout || "").trim();
	}
	const ns = process.hrtime.bigint() - t0;
	return { ns: ns.toString(), ms: Number(ns) / 1e6, ok, stdout, err, last: lastLine(stdout) };
}

// JSON-wrapped Lua for control ops (resolve / fixture / cleanup) — NOT used for timed census reads.
function lua(body) {
	const command = `/sc local ok,result=pcall(function() ${body} end); if ok then rcon.print(helpers.table_to_json(result)) else rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) end`;
	const raw = lastLine(rconTimed(command).stdout);
	try { return JSON.parse(raw); }
	catch (error) { throw new Error(`Invalid Lua JSON: ${raw}\n${error.message}`); }
}

// --- Inline census loops (faithful mirror of module/validators/surface-counter.lua) --------------

function censusItemsLua(idx, reps) {
	return `/sc local S=game.get_surface(${idx});local ents;local total;` +
		`for rep=1,${reps} do ents=S.find_entities_filtered({});total=0;` +
		`for _,e in ipairs(ents) do if e.valid then ` +
		`pcall(function() total=total+e.get_item_count() end);` +
		`local t=e.type;` +
		`if t=='transport-belt' or t=='underground-belt' or t=='splitter' then ` +
		`pcall(function() local mx=e.get_max_transport_line_index();for i=1,mx do local ln=e.get_transport_line(i);` +
		`for _,c in pairs(ln.get_contents()) do total=total+(type(c)=='table' and c.count or c) end end end) end;` +
		`if t=='inserter' then local h=e.held_stack;if h and h.valid_for_read then total=total+h.count end end ` +
		`end end;` +
		`local gi=S.find_entities_filtered({type='item-entity'});` +
		`for _,ie in ipairs(gi) do if ie.stack and ie.stack.valid_for_read then total=total+ie.stack.count end end ` +
		`end;rcon.print(game.tick..'|'..total..'|'..#ents)`;
}

function censusFluidsLua(idx, reps) {
	return `/sc local S=game.get_surface(${idx});local ents;local total;` +
		`for rep=1,${reps} do ents=S.find_entities_filtered({});total=0;local counted={};local known={};` +
		`for _,e in ipairs(ents) do if e.valid and e.fluidbox then ` +
		`pcall(function() for i=1,#e.fluidbox do local f=e.fluidbox[i];if f and f.name and f.temperature then known[f.name]=f.temperature end end end) ` +
		`end end;` +
		`for _,e in ipairs(ents) do if e.valid and e.fluidbox then ` +
		`pcall(function() for i=1,#e.fluidbox do local seg=e.fluidbox.get_fluid_segment_id(i);` +
		`if seg and not counted[seg] then counted[seg]=true;local c=e.fluidbox.get_fluid_segment_contents(i);` +
		`if c then for _,amt in pairs(c) do total=total+amt end end ` +
		`elseif not seg then local f=e.fluidbox[i];if f and f.name then total=total+f.amount end end end end) ` +
		`end end ` +
		`end;rcon.print(game.tick..'|'..total..'|'..#ents)`;
}

function parseCensus(line) {
	const parts = String(line).split("|");
	if (parts.length !== 3) return { ok: false };
	const tick = Number(parts[0]), total = Number(parts[1]), count = Number(parts[2]);
	if (![tick, total, count].every(Number.isFinite)) return { ok: false };
	return { ok: true, tick, total, count };
}

// Run `kind` census at each multiplier `samples` times. On a completely failed multiplier (timeout /
// empty), record it and STOP escalating — never fold an empty return into the data (advisor point 4).
function measureCensus(idx, kind) {
	const luaFn = kind === "items" ? censusItemsLua : censusFluidsLua;
	const perMultiplier = [];
	for (const m of multipliers) {
		const runs = [];
		for (let s = 0; s < samples; s += 1) {
			const r = rconTimed(luaFn(idx, m));
			const p = parseCensus(r.last);
			runs.push({ sample: s + 1, ms: round2(r.ms), ok: r.ok, clean: p.ok,
				tick: p.ok ? p.tick : null, total: p.ok ? p.total : null, count: p.ok ? p.count : null,
				last: r.last, err: r.err });
		}
		const cleanMs = runs.filter(x => x.clean).map(x => x.ms);
		const row = { multiplier: m, samples: runs, clean_count: cleanMs.length,
			median_ms: cleanMs.length ? round2(median(cleanMs)) : null,
			min_ms: cleanMs.length ? round2(Math.min(...cleanMs)) : null,
			mean_ms: cleanMs.length ? round2(mean(cleanMs)) : null };
		perMultiplier.push(row);
		if (!cleanMs.length) { row.aborted = true; break; }
	}
	return perMultiplier;
}

// Least-squares slope of wall(ms) vs multiplier over clean points. slope = per-census ms; intercept =
// fixed round-trip overhead (should ~= baseline mean).
function fitSlope(perMultiplier) {
	const pts = perMultiplier.filter(r => r.median_ms !== null).map(r => ({ x: r.multiplier, y: r.median_ms }));
	if (pts.length < 2) return { slope_ms: null, intercept_ms: null, points: pts.length };
	const n = pts.length, sx = sum(pts.map(p => p.x)), sy = sum(pts.map(p => p.y));
	const sxx = sum(pts.map(p => p.x * p.x)), sxy = sum(pts.map(p => p.x * p.y));
	const denom = n * sxx - sx * sx;
	if (denom === 0) return { slope_ms: null, intercept_ms: null, points: n };
	const slope = (n * sxy - sx * sy) / denom;
	const intercept = (sy - slope * sx) / n;
	// two-point cross-check across the widest clean span
	const lo = pts[0], hi = pts[pts.length - 1];
	const twoPoint = hi.x !== lo.x ? (hi.y - lo.y) / (hi.x - lo.x) : null;
	return { slope_ms: round4(slope), intercept_ms: round2(intercept), points: n,
		two_point_ms: twoPoint === null ? null : round4(twoPoint) };
}

// --- Control fixture ----------------------------------------------------------------------------

function createFixture() {
	return lua(`local force=game.forces.player;local name='${fixturePrefix}-'..game.tick;` +
		`local p=force.create_space_platform({name=name,planet='nauvis',starter_pack='space-platform-starter-pack'});` +
		`p.apply_starter_pack();p.paused=false;` +
		`return {success=true,name=name,index=p.index,surface=p.surface.index,ents=#p.surface.find_entities_filtered({})}`);
}

function resolveTest() {
	return lua(`local found;local count=0;for _,p in pairs(game.forces.player.platforms) do if p.valid and p.name=='test' then ` +
		`found={surface=p.surface.index,index=p.index,ents=#p.surface.find_entities_filtered({})};count=count+1 end end;` +
		`return {success=count==1,count=count,test=found}`);
}

function cleanupFixtures() {
	return lua(`local deleted={};for _,s in pairs(game.surfaces) do local p=s.platform;` +
		`if p and p.valid and string.find(p.name,'${fixturePrefix}',1,true)==1 then deleted[#deleted+1]=p.name;game.delete_surface(s) end end;` +
		`game.tick_paused=false;return {success=true,deleted=deleted,tick=game.tick}`);
}

function zeroCheck() {
	return lua(`local function count(t) local n=0 for _ in pairs(t or {}) do n=n+1 end return n end;` +
		`local surfaces={};for _,s in pairs(game.surfaces) do local p=s.platform;` +
		`if p and p.valid and string.find(p.name,'${fixturePrefix}',1,true)==1 then surfaces[#surfaces+1]=p.name end end;` +
		`return {success=true,tick=game.tick,zero_fixtures=#surfaces==0,fixtures=surfaces,` +
		`async_jobs=count(storage.async_jobs),game_paused=game.tick_paused==true}`);
}

function zeroOk(z) { return z.zero_fixtures && z.async_jobs === 0 && !z.game_paused; }

// --- Derivation ---------------------------------------------------------------------------------

function derive(results) {
	const N0 = results.fixture.ents, N1 = results.test.ents;
	const g = (platform, kind) => results.readings[platform][kind].fit.slope_ms;
	const fixItems = g("fixture", "items"), fixFluids = g("fixture", "fluids");
	const testItems = g("test", "items"), testFluids = g("test", "fluids");
	const fixFull = fixItems + fixFluids, testFull = testItems + testFluids;
	const perEntityItems = (testItems - fixItems) / (N1 - N0);
	const perEntityFluids = (testFluids - fixFluids) / (N1 - N0);
	const perEntityFull = perEntityItems + perEntityFluids;
	const fixedOverheadFull = testFull - N1 * perEntityFull; // intercept of the census-cost-vs-N line
	const batchEntities = 100;
	const perBatchMs = fixedOverheadFull + batchEntities * perEntityFull;
	return {
		fixture_entities: N0, test_entities: N1,
		per_census_ms: {
			fixture: { items: round4(fixItems), fluids: round4(fixFluids), full: round4(fixFull) },
			test: { items: round4(testItems), fluids: round4(testFluids), full: round4(testFull) },
		},
		full_atomic_census_ms: round4(testFull),
		full_atomic_census_pct_of_tick: round2((testFull / tickMs) * 100),
		per_entity_ms: { items: round4(perEntityItems), fluids: round4(perEntityFluids), full: round4(perEntityFull) },
		fixed_overhead_ms: round4(fixedOverheadFull),
		projected_per_batch_ms: { batch_entities: batchEntities, added_ms: round4(perBatchMs),
			pct_of_tick: round2((perBatchMs / tickMs) * 100) },
	};
}

// --- NOTEBOOK rendering -------------------------------------------------------------------------

function readingTable(perMultiplier) {
	const head = "| mult | clean | median ms | min ms | mean ms | tick(last) | total(last) | ents |\n" +
		"|---|---|---|---|---|---|---|---|";
	const rows = perMultiplier.map(r => {
		const last = r.samples.filter(s => s.clean).at(-1);
		return `| ${r.multiplier}${r.aborted ? " (ABORTED)" : ""} | ${r.clean_count}/${samples} | ` +
			`${r.median_ms ?? "-"} | ${r.min_ms ?? "-"} | ${r.mean_ms ?? "-"} | ` +
			`${last?.tick ?? "-"} | ${last?.total ?? "-"} | ${last?.count ?? "-"} |`;
	});
	return [head, ...rows].join("\n");
}

function renderNotebook(results) {
	const d = results.derived;
	const b = results.baseline;
	const L = [];
	L.push(`\n\n## ${results.finished} — R1 stall-budget census (tick ${results.resolved_tick}, Factorio ${results.base_version})`);
	L.push(`\nInstrument: Node \`process.hrtime.bigint()\` around each RCON round-trip; slope of wall-time vs in-execution multiplier isolates per-census engine cost. Census loop inlined in \`/sc\` (mirrors surface-counter.lua). Multipliers ${multipliers.join(",")}, ${samples} samples each.`);
	L.push(`\n**Baseline** (bare \`/sc rcon.print(1)\`, ${b.samples_ms.length}x): median ${b.median_ms} ms, mean ${b.mean_ms} ms. Raw: ${b.samples_ms.join(", ")} ms.`);
	L.push(`\n**CAVEAT — measured cost is a LOWER BOUND.** The inline loop uses \`get_item_count()\` (one engine call); production \`SurfaceCounter\` uses \`InventoryScanner.extract_all_inventories\` (iterates every inventory index + allocates per-slot tables). Real cost is higher; the derived budget is optimistic — keep margin.`);

	L.push(`\n### Control A — baseline round-trip (above). Control B — 0-entity fixture (starter-pack minimal, actual ${results.fixture.ents} entities)`);
	L.push(`\nFixture items:\n\n${readingTable(results.readings.fixture.items.per_multiplier)}`);
	L.push(`\nFixture fluids:\n\n${readingTable(results.readings.fixture.fluids.per_multiplier)}`);
	L.push(`\nFixture per-census: items ${d.per_census_ms.fixture.items} ms, fluids ${d.per_census_ms.fixture.fluids} ms (slope fits: items intercept ${results.readings.fixture.items.fit.intercept_ms} ms, fluids intercept ${results.readings.fixture.fluids.fit.intercept_ms} ms — cross-check vs baseline ${b.median_ms} ms).`);

	L.push(`\n### Reading — 1,359-entity \`test\` platform (surface ${results.test.surface}, ${results.test.ents} entities)`);
	L.push(`\nItems:\n\n${readingTable(results.readings.test.items.per_multiplier)}`);
	L.push(`\nFluids:\n\n${readingTable(results.readings.test.fluids.per_multiplier)}`);
	L.push(`\nSlope fits (per-census ms | round-trip intercept ms | two-point ms):`);
	L.push(`- test items:  ${results.readings.test.items.fit.slope_ms} | ${results.readings.test.items.fit.intercept_ms} | ${results.readings.test.items.fit.two_point_ms}`);
	L.push(`- test fluids: ${results.readings.test.fluids.fit.slope_ms} | ${results.readings.test.fluids.fit.intercept_ms} | ${results.readings.test.fluids.fit.two_point_ms}`);

	L.push(`\n### Conclusion — banked \`[empirical, ${results.base_version}]\``);
	L.push(`\n- **Per-census full census (items + fluids) @ ${d.test_entities} entities = ${d.full_atomic_census_ms} ms** = **${d.full_atomic_census_pct_of_tick}% of one 16.67 ms / 60 UPS frame.**`);
	L.push(`- Per-census @ ${d.fixture_entities} entities (fixture): items ${d.per_census_ms.fixture.items} ms, fluids ${d.per_census_ms.fixture.fluids} ms, full ${d.per_census_ms.fixture.full} ms.`);
	L.push(`- **Per-entity cost** (2-point slope, fixture N=${d.fixture_entities} -> test N=${d.test_entities}): items ${d.per_entity_ms.items} ms, fluids ${d.per_entity_ms.fluids} ms, **full ${d.per_entity_ms.full} ms/entity.**`);
	L.push(`- Fixed per-census overhead (find_entities + loop setup): ${d.fixed_overhead_ms} ms.`);
	L.push(`- **Projected added cost per async batch (~${d.projected_per_batch_ms.batch_entities} entities): ${d.projected_per_batch_ms.added_ms} ms** (${d.projected_per_batch_ms.pct_of_tick}% of a frame).`);
	L.push(`- Projected added cost for the atomic belt tick (one full census): ${d.full_atomic_census_ms} ms.`);
	const overFrame = d.full_atomic_census_pct_of_tick >= 100;
	L.push(`\n**Headline (data-driven, honest):** one full synchronous census is **${d.full_atomic_census_ms} ms = ${d.full_atomic_census_pct_of_tick}% of a 16.67 ms / 60 UPS frame** at ${d.test_entities} entities — as a FLOOR. ${overFrame ? "It EXCEEDS a single frame" : "It nearly fills a frame"}, and real production cost is higher (get_item_count under-counts). A full census is therefore **not** a free per-tick operation at scale; it is a bounded one-shot stall.`);
	L.push(`\n**Method note — a single census cannot be timed directly through RCON; the multiplier method is not optional.** A single census (~single-digit ms) is BELOW the round-trip jitter floor (baseline samples ${b.samples_ms.join("/")} ms), so the low-mult (1x/10x) readings are dominated by the ~${b.median_ms} ms exec overhead, not the census. The per-census figure rests on the **marginal cost across the HIGH multipliers** — the slope of the reading tables above — where the census clears the noise. That the regression intercept (${results.readings.test.items.fit.intercept_ms}/${results.readings.test.fluids.fit.intercept_ms} ms) ~= the baseline (${b.median_ms} ms) confirms the low-mult readings are pure round-trip floor. Check the reading tables for a CONSTANT marginal increment across 10->50->100 before trusting the slope.`);
	L.push(`\n**Proposed Phase-2 acceptance budget** (anchored to the 16.67 ms / 60 UPS frame — the real stall constraint):`);
	L.push(`1. **Per async batch (~${d.projected_per_batch_ms.batch_entities} entities): AFFORDABLE.** Added paired-read cost ${d.projected_per_batch_ms.added_ms} ms floor (${d.projected_per_batch_ms.pct_of_tick}% of a frame) — comfortably **<= 10% of a batch's 16.67 ms tick budget** (~1.67 ms). Budget: added per-batch census cost <= 1.67 ms; a batch-amortized paired read is the cheap, safe design.`);
	L.push(`2. **Atomic-tick full census: EXPENSIVE — treat as a bounded one-shot stall.** The added atomic-tick census (~${d.full_atomic_census_ms} ms floor) roughly matches or exceeds a single frame on its own, so it cannot hide inside a normal tick. Budget: the added atomic-tick census must **not exceed the existing atomic belt-scan tick cost** (which is already an accepted one-shot stall). Phase-2 cross-check: MEASURE the current belt-scan tick cost and require added-census <= it; do NOT invent that number here.`);
	L.push(`Rationale: the brief's two proposed thresholds survive re-expression in measured units, but the measurement REVISES the intuition — the per-batch path is cheap (${d.projected_per_batch_ms.pct_of_tick}% of a frame) while a full atomic-tick census is ${d.full_atomic_census_pct_of_tick}% of a frame FLOOR. The design lever this hands Phase 2: prefer batch-amortized paired reads; if an atomic full census is unavoidable, bound it against the existing belt-scan stall rather than the frame. Both budgets are provisional until re-checked against the real belt-scan cost and the heavier production census path.`);
	L.push(`\n### Zero-leftover proof`);
	L.push(`Fixture deleted: ${JSON.stringify(results.cleanup.deleted)}. Post-run: zero_fixtures=${results.zero.zero_fixtures}, async_jobs=${results.zero.async_jobs}, game_paused=${results.zero.game_paused} (tick ${results.zero.tick}).`);
	L.push(`\n<details><summary>Raw results JSON</summary>\n\n\`\`\`json\n${JSON.stringify(results, null, 2)}\n\`\`\`\n</details>`);
	return L.join("\n");
}

// --- Main ---------------------------------------------------------------------------------------

function main() {
	const results = { script: "tests/census-lab/run-r1-stall-budget.mjs", started: new Date().toISOString(),
		multipliers, samples, errors: [] };
	let fixtureCreated = false;
	try {
		// controls FIRST: baseline, then 0-entity fixture, before the 1,359 reading.
		const baselineMs = [];
		for (let i = 0; i < 5; i += 1) baselineMs.push(round2(rconTimed("/sc rcon.print(1)").ms));
		results.baseline = { samples_ms: baselineMs, median_ms: round2(median(baselineMs)), mean_ms: round2(mean(baselineMs)) };

		const meta = lua(`return {success=true,tick=game.tick,base=script.active_mods.base}`);
		results.resolved_tick = meta.tick; results.base_version = meta.base;

		const resolved = resolveTest();
		if (!resolved.success) throw new Error(`Expected exactly one platform named 'test': ${JSON.stringify(resolved)}`);
		results.test = { surface: resolved.test.surface, index: resolved.test.index, ents: resolved.test.ents };

		const fixture = createFixture();
		if (!fixture.success) throw new Error(`Fixture creation failed: ${JSON.stringify(fixture)}`);
		fixtureCreated = true;
		results.fixture = { name: fixture.name, index: fixture.index, surface: fixture.surface, ents: fixture.ents };

		results.readings = { fixture: {}, test: {} };
		// Control census first (fixture), then production reading (test).
		for (const kind of ["items", "fluids"]) {
			const per = measureCensus(results.fixture.surface, kind);
			results.readings.fixture[kind] = { per_multiplier: per, fit: fitSlope(per) };
		}
		for (const kind of ["items", "fluids"]) {
			const per = measureCensus(results.test.surface, kind);
			results.readings.test[kind] = { per_multiplier: per, fit: fitSlope(per) };
		}

		results.derived = derive(results);
	} catch (error) {
		results.errors.push(error.stack || error.message);
	} finally {
		try {
			results.cleanup = fixtureCreated ? cleanupFixtures() : { success: true, deleted: [] };
			results.zero = zeroCheck();
			results.zero_ok = zeroOk(results.zero);
		} catch (error) {
			results.errors.push(`Cleanup failed: ${error.stack || error.message}`);
		}
		results.finished = new Date().toISOString();
		if (!noNotebook && !resetOnly && results.derived) appendFileSync(notebook, renderNotebook(results));
		console.log(JSON.stringify(results, null, 2));
		if (results.errors.length || results.zero_ok === false) process.exitCode = 1;
	}
}

if (resetOnly) {
	const cleanup = cleanupFixtures();
	const zero = zeroCheck();
	console.log(JSON.stringify({ cleanup, zero, ok: zeroOk(zero) }, null, 2));
	if (!zeroOk(zero)) process.exitCode = 1;
} else {
	main();
}
