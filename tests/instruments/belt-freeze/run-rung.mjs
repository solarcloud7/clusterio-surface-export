#!/usr/bin/env node
// belt-freeze — what actually stops a transport belt at this engine pin?
//
// requires: a running surface-export cluster with a platform whose transport belts carry MOVING items
// produces: per-arm moved/still belt counts on a throwaway clone, a REPRODUCED / DIVERGED verdict
//           for each of: paused-platform advance, disabled_by_script on a belt, circuit enable/disable,
//           and a counted, logged retry of the circuit arm (arm-selection.mjs decides; the verdict
//           itself is never retried)
// does not: measure belt RESTORATION fidelity, exercise the import path's freeze window, assert
//           anything about item conservation, or touch a protected fixture (it clones and sweeps).
//           The wired arm's platform-wide "still moving" count is NOT a control arm: a saturated
//           loop jams behind a stopped belt, so that number goes to zero for a lawful reason.

import { createBatchLifecycle } from "../../lab-gallery/batch-lifecycle.mjs";
import { ARM_ATTEMPT_LIMIT, buildCandidatePool, planNextAttempt } from "./arm-selection.mjs";

const L = createBatchLifecycle({
	goldenSourceSave: "unused.zip", goldenDestSave: "unused.zip", markerPrefix: "beltfreeze",
});
const HOST = 1;
const CLONE_STAMP = Date.now().toString(36);
const WINDOW_MS = 4000;
const MIN_WINDOW_TICKS = 60;
const WIRE_PAIRS = 6;
const MOVED_UNITS_CAP = 500;
const CLONE_WAIT_MS = 180_000;
const EXPECTED_FACTS = 3;

const clones = [];
function nextCloneName() {
	const name = clones.length === 0 ? `beltfreeze-${CLONE_STAMP}` : `beltfreeze-${CLONE_STAMP}r${clones.length + 1}`;
	clones.push(name);
	return name;
}

const say = (...a) => console.log(...a);
const problems = [];

function fail(message) {
	problems.push(message);
	process.exitCode = 1;
	say(`  !! ${message}`);
}

function lua(body) {
	const r = L.lua(HOST, body);
	if (r === null || typeof r !== "object") throw new Error(`lua returned no object: ${JSON.stringify(r)}`);
	if (r.success !== true) throw new Error(`lua failed: ${r.error ?? JSON.stringify(r)}`);
	return r;
}

function nums(r, fields) {
	for (const f of fields) {
		if (typeof r[f] !== "number") throw new Error(`lua answer is missing numeric '${f}': ${JSON.stringify(r)}`);
	}
	return r;
}

const PRE = `
local st = storage.__belt_freeze_rung
if not st then return { success = false, error = 'rung storage missing' } end
local p
for _, pl in pairs(game.forces.player.platforms) do if pl.index == st.platform then p = pl end end
if not (p and p.valid) then return { success = false, error = 'platform index '..tostring(st.platform)..' not found' } end
local s = p.surface
if not (s and s.valid) then return { success = false, error = 'platform has no valid surface' } end
local function belts() return s.find_entities_filtered{ type = 'transport-belt' } end
local function line_sig(e)
  local parts, n = {}, 0
  for li = 1, e.get_max_transport_line_index() do
    local ps = {}
    for _, d in ipairs(e.get_transport_line(li).get_detailed_contents()) do
      local q = d.stack.quality
      ps[#ps + 1] = string.format('%s.%s@%.4f', d.stack.name, q and q.name or 'normal', d.position)
      n = n + 1
    end
    parts[#parts + 1] = table.concat(ps, ',')
  end
  return table.concat(parts, '|'), n
end
local function status_name(e)
  for k, v in pairs(defines.entity_status) do if v == e.status then return k end end
  return 'unknown'
end
local function by_unit()
  local m = {}
  for _, e in pairs(belts()) do m[e.unit_number] = e end
  return m
end
`;

const SNAP = PRE + `
local snap, carrying = {}, 0
for _, e in pairs(belts()) do
  local sig, n = line_sig(e)
  if n > 0 then snap[e.unit_number] = sig carrying = carrying + 1 end
end
st.snap = snap
st.snap_tick = game.tick
return { success = true, carrying = carrying, tick = game.tick, paused = p.paused }
`;

const MEASURE = PRE + `
local before = st.snap
if not before then return { success = false, error = 'no baseline snapshot' } end
local frozen = st.frozen or {}
local partners = st.partners or {}
local moved, still, gone = 0, 0, 0
local frozen_moved, frozen_still, control_moved, control_still = 0, 0, 0, 0
local moved_units, seen = {}, {}
for _, e in pairs(belts()) do
  local prev = before[e.unit_number]
  if prev ~= nil then
    seen[e.unit_number] = true
    local sig = line_sig(e)
    if sig ~= prev then
      moved = moved + 1
      if #moved_units < ${MOVED_UNITS_CAP} then moved_units[#moved_units + 1] = e.unit_number end
      if frozen[e.unit_number] then frozen_moved = frozen_moved + 1
      elseif not partners[e.unit_number] then control_moved = control_moved + 1 end
    else
      still = still + 1
      if frozen[e.unit_number] then frozen_still = frozen_still + 1
      elseif not partners[e.unit_number] then control_still = control_still + 1 end
    end
  end
end
for unit in pairs(before) do if not seen[unit] then gone = gone + 1 end end
local tracked = 0
for _ in pairs(before) do tracked = tracked + 1 end
return { success = true, tracked = tracked, moved = moved, still = still, gone = gone,
  frozen_moved = frozen_moved, frozen_still = frozen_still,
  control_moved = control_moved, control_still = control_still,
  window_ticks = game.tick - st.snap_tick, tick = game.tick, paused = p.paused,
  moved_units = moved_units }
`;

const INVENTORY = `
local out = {}
for _, pl in pairs(game.forces.player.platforms) do
  if pl.valid and pl.surface and pl.surface.valid then
    local belts, carrying, items = 0, 0, 0
    for _, e in pairs(pl.surface.find_entities_filtered{ type = 'transport-belt' }) do
      belts = belts + 1
      local n = 0
      for li = 1, e.get_max_transport_line_index() do n = n + #e.get_transport_line(li) end
      if n > 0 then carrying = carrying + 1 items = items + n end
    end
    out[#out + 1] = { index = pl.index, name = pl.name, paused = pl.paused,
      belts = belts, carrying = carrying, items = items }
  end
end
return { success = true, platforms = out }
`;

const SELECT_WIRE_SET = PRE + `
local units = st.moved_units or {}
local m = by_unit()
local function unwired(e)
  local n = 0
  for _, c in pairs(e.get_wire_connectors(false)) do n = n + c.connection_count end
  return n == 0
end
local frozen, partners, wire_pairs = {}, {}, {}
local rejected_wired, rejected_status = 0, 0
for _, u in ipairs(units) do
  if #wire_pairs >= ${WIRE_PAIRS} then break end
  local e = m[u]
  if e and not frozen[u] and not partners[u] then
    if not unwired(e) then rejected_wired = rejected_wired + 1
    elseif status_name(e) ~= 'working' then rejected_status = rejected_status + 1
    else
      local nb
      for _, o in pairs(s.find_entities_filtered{ type = 'transport-belt', position = e.position, radius = 2 }) do
        if o.unit_number ~= u and not frozen[o.unit_number] and not partners[o.unit_number] and unwired(o) then
          nb = o break
        end
      end
      if nb then
        frozen[u] = true
        partners[nb.unit_number] = true
        wire_pairs[#wire_pairs + 1] = { belt = u, partner = nb.unit_number }
      end
    end
  end
end
st.frozen = frozen
st.partners = partners
st.wire_pairs = wire_pairs
return { success = true, selected = #wire_pairs, candidates = #units,
  rejected_wired = rejected_wired, rejected_status = rejected_status, wire_pairs = wire_pairs }
`;

const ARM_SELECTED = PRE + `
local m = by_unit()
local armed = 0
for u in pairs(st.frozen or {}) do
  local e = m[u]
  if e then
    local cb = e.get_or_create_control_behavior()
    cb.circuit_enable_disable = true
    cb.circuit_condition = { comparator = '<',
      first_signal = { type = 'virtual', name = 'signal-A' }, constant = 0 }
    armed = armed + 1
  end
end
return { success = true, armed = armed }
`;

const DISARM = PRE + `
local m = by_unit()
local cleared, missing = 0, 0
for _, pr in ipairs(st.wire_pairs or {}) do
  local e = m[pr.belt]
  if e then
    e.get_or_create_control_behavior().circuit_enable_disable = false
    cleared = cleared + 1
  else missing = missing + 1 end
end
st.frozen = nil
st.partners = nil
st.wire_pairs = nil
st.last_movers = nil
return { success = true, cleared = cleared, missing = missing }
`;

const NARROW_TO_MOVERS = PRE + `
local movers = {}
for _, u in ipairs(st.last_movers or {}) do movers[u] = true end
local kept, dropped = {}, 0
for u in pairs(st.frozen or {}) do
  if movers[u] then kept[u] = true else st.partners[u] = true dropped = dropped + 1 end
end
st.frozen = kept
local n = 0
for _ in pairs(kept) do n = n + 1 end
return { success = true, kept = n, dropped = dropped }
`;

const FROZEN_STATUS = PRE + `
local m = by_unit()
local counts, missing = {}, 0
for u in pairs(st.frozen or {}) do
  local e = m[u]
  if e then
    local n = status_name(e)
    counts[n] = (counts[n] or 0) + 1
  else missing = missing + 1 end
end
return { success = true, statuses = counts, missing = missing }
`;

async function snapshotAndMeasure(label) {
	const snap = lua(SNAP);
	if (typeof snap.carrying !== "number" || snap.carrying === 0) {
		throw new Error(`${label}: baseline snapshot found no belt carrying items (carrying=${snap.carrying})`);
	}
	await L.sleep(WINDOW_MS);
	const m = nums(lua(MEASURE), ["tracked", "moved", "still", "gone", "window_ticks",
		"frozen_moved", "frozen_still", "control_moved", "control_still"]);
	if (m.window_ticks < MIN_WINDOW_TICKS) {
		throw new Error(`${label}: only ${m.window_ticks} tick(s) elapsed over the ${WINDOW_MS} ms window ` +
			"(minimum " + MIN_WINDOW_TICKS + ") — the instance is stalled and no arm can be read");
	}
	say(`  ${label}: paused=${m.paused} tracked=${m.tracked} moved=${m.moved} still=${m.still} ` +
		`gone=${m.gone} window=${m.window_ticks}t ` +
		`[frozen ${m.frozen_moved}/${m.frozen_moved + m.frozen_still} moved, ` +
		`control ${m.control_moved}/${m.control_moved + m.control_still} moved]`);
	if (m.gone > 0) {
		fail(`${label}: ${m.gone} of ${m.gone + m.tracked} tracked belts no longer exist at measure time. ` +
			"A destroyed belt is counted neither moved nor still, so every count in this arm is over a " +
			"population that shrank while it was being measured.");
	}
	return m;
}

async function cloneFixture(sourceIndex, sourceName) {
	const clone = nextCloneName();
	const queued = lua(`local r = remote.call('surface_export', 'clone_platform', ${sourceIndex}, '${clone}')
		if not r or r.success ~= true then return { success = false, error = tostring(r and r.error or 'no answer') } end
		return { success = true, job_id = r.job_id, entity_count = r.entity_count }`);
	say(`clone of '${sourceName}' [${sourceIndex}] -> ${clone}: job=${queued.job_id} entities=${queued.entity_count}`);
	const deadline = Date.now() + CLONE_WAIT_MS;
	while (Date.now() < deadline) {
		const state = lua(`local idx
			for _, pl in pairs(game.forces.player.platforms) do if pl.name == '${clone}' then idx = pl.index end end
			return { success = true, jobs = table_size(storage.async_jobs or {}), index = idx or -1 }`);
		if (state.index > 0 && state.jobs === 0) {
			lua(`storage.__belt_freeze_rung.platform = ${state.index}
				storage.__belt_freeze_rung.snap = nil
				storage.__belt_freeze_rung.frozen = nil
				storage.__belt_freeze_rung.partners = nil
				storage.__belt_freeze_rung.wire_pairs = nil
				storage.__belt_freeze_rung.last_movers = nil
				return { success = true }`);
			return state.index;
		}
		await L.sleep(3000);
	}
	throw new Error(`clone '${clone}' did not materialize within ${CLONE_WAIT_MS} ms`);
}

function dropClone(name) {
	const dropped = L.lua(HOST, `local removed = 0
		for _, pl in pairs(game.forces.player.platforms) do
		  if pl.valid and pl.name == '${name}' then
		    if pl.surface and pl.surface.valid then game.delete_surface(pl.surface) end
		    removed = removed + 1
		  end
		end
		return { success = true, removed = removed }`);
	say(`  discarded the jammed clone ${name}: ${JSON.stringify(dropped)}`);
}

async function runCircuitArm(attempt, pool, priorControl) {
	lua(`storage.__belt_freeze_rung.moved_units = {${pool.join(",")}}
		return { success = true }`);
	const selection = nums(lua(SELECT_WIRE_SET),
		["selected", "candidates", "rejected_wired", "rejected_status"]);
	say(`  wire set (attempt ${attempt}/${ARM_ATTEMPT_LIMIT}): ${selection.selected} belt(s) chosen from ` +
		`${selection.candidates} that MEASURED MOVING (rejected ${selection.rejected_wired} already-wired, ` +
		`${selection.rejected_status} not status=working)`);
	if (selection.selected === 0) {
		return { ok: false, failure: "no-selection", control: priorControl,
			message: "ARM D/E INVALID: no moving, unwired belt had a moving-range unwired belt neighbour, so the " +
				"wire variable cannot be flipped. The circuit fact is NOT measured this run." };
	}
	const armedStatus = nums(lua(ARM_SELECTED), ["armed"]);
	await L.sleep(1000);
	const statusNoWire = lua(FROZEN_STATUS);
	say(`  armed=${armedStatus.armed} status(no wire)=${JSON.stringify(statusNoWire.statuses)}`);
	if (statusNoWire.statuses?.working !== selection.selected) {
		return { ok: false, terminal: true,
			message: `ARM D INVALID: ${selection.selected} armed belts should all read status=working before any ` +
				`wire exists; got ${JSON.stringify(statusNoWire.statuses)}. The wire variable is not isolated — ` +
				"a candidate carries a circuit connection this selection failed to exclude." };
	}
	const armD = await snapshotAndMeasure(`ARM D armed, no wire (attempt ${attempt})`);
	lua(`storage.__belt_freeze_rung.last_movers = {${(armD.moved_units ?? []).join(",")}}
		return { success = true }`);
	const narrowed = nums(lua(NARROW_TO_MOVERS), ["kept", "dropped"]);
	say(`  measured set narrowed to the ${narrowed.kept} armed belt(s) that MOVED in ARM D ` +
		`(${narrowed.dropped} dropped)`);
	const control = { moved: armD.control_moved, tracked: armD.control_moved + armD.control_still };
	if (narrowed.kept === 0) {
		return { ok: false, failure: "armed-set-still", control, armD,
			message: "ARM E INVALID: no armed belt moved in ARM D, so a later stillness proves nothing about the wire." };
	}
	return { ok: true, selection, statusNoWire, armD, narrowed };
}

let baseline = null;
const verdicts = [];
function verdict(id, claim, status, evidence) {
	verdicts.push({ id, claim, status, evidence });
	say(`  ${id} ${status}: ${claim}`);
	say(`      evidence: ${evidence}`);
	if (status !== "REPRODUCED") fail(`${id} ${status} — ${claim}`);
}

async function main() {
	try {
		baseline = lua(`return { success = true,
			jobs = table_size(storage.async_jobs or {}),
			locks = table_size(storage.locked_platforms or {}),
			holds = table_size(storage.destination_holds or {}),
			tick_paused = game.tick_paused == true }`);
		say(`cluster state before this run: ${JSON.stringify(baseline)}`);
		lua("storage.__belt_freeze_rung = { platform = -1 } return { success = true }");

		say("\n=== fixture check: which platform's belts actually MOVE? ===");
		const inv = L.lua(HOST, INVENTORY);
		if (inv.success !== true || !Array.isArray(inv.platforms) || inv.platforms.length === 0) {
			throw new Error(`platform inventory came back empty or unusable: ${JSON.stringify(inv)}`);
		}
		let source = null;
		for (const candidate of inv.platforms) {
			say(`  [${candidate.index}] ${candidate.name} paused=${candidate.paused} ` +
				`belts=${candidate.belts} carrying=${candidate.carrying} items=${candidate.items}`);
			if (candidate.carrying === 0) continue;
			lua(`storage.__belt_freeze_rung.platform = ${candidate.index} return { success = true }`);
			const m = await snapshotAndMeasure(`  fixture ${candidate.name}`);
			if (m.moved > 0) { source = candidate; break; }
		}
		if (source === null) {
			fail("no available platform carries MOVING belt items — this rung cannot be run against the " +
				"current fixtures, and inventing a different fixture is not a substitute. Report the gap.");
			return;
		}
		say(`  fixture selected: [${source.index}] ${source.name}`);

		say("\n=== clone ===");
		await cloneFixture(source.index, source.name);

		say("\n=== ARM A (control): clone UNPAUSED — can the instrument see motion at all? ===");
		const unpaused = lua(PRE + "p.paused = false return { success = true, paused = p.paused }");
		if (unpaused.paused !== false) throw new Error("clone did not unpause; every later arm would be confounded");
		await L.sleep(2000);
		const armA = await snapshotAndMeasure("ARM A unpaused");
		if (armA.moved === 0) {
			fail(`ARM A INVALID: the instrument saw ZERO of ${armA.tracked} carrying belts move on an UNPAUSED ` +
				"clone. A probe that cannot see motion reports every later arm as 'frozen'. No fact is measured.");
			return;
		}
		say(`  control arm OK — the instrument sees motion (${armA.moved}/${armA.tracked}).`);

		say("\n=== ARM B: platform.paused = true ===");
		const paused = lua(PRE + "p.paused = true return { success = true, paused = p.paused }");
		if (paused.paused !== true) throw new Error("platform.paused readback is not true — arm B cannot be read");
		await L.sleep(1000);
		const armB = await snapshotAndMeasure("ARM B paused");
		verdict("F1", "a PAUSED platform's transport lines keep advancing",
			armB.moved > 0 ? "REPRODUCED" : "DIVERGED",
			`paused=${armB.paused}: ${armB.moved}/${armB.tracked} carrying belts changed their line contents ` +
			`over ${armB.window_ticks} ticks (unpaused control arm: ${armA.moved}/${armA.tracked})`);

		say("\n=== ARM C: disabled_by_script = true on every transport belt ===");
		lua(PRE + "p.paused = false return { success = true }");
		await L.sleep(1000);
		const written = nums(lua(PRE + `
			local wrote, readback_true, threw = 0, 0, 0
			for _, e in pairs(belts()) do
			  local ok = pcall(function() e.disabled_by_script = true end)
			  if ok then wrote = wrote + 1 if e.disabled_by_script == true then readback_true = readback_true + 1 end
			  else threw = threw + 1 end
			end
			return { success = true, wrote = wrote, readback_true = readback_true, threw = threw }`),
		["wrote", "readback_true", "threw"]);
		say(`  wrote disabled_by_script=true on ${written.wrote} belts ` +
			`(threw on ${written.threw}); readback true on ${written.readback_true}`);
		const armC = await snapshotAndMeasure("ARM C disabled_by_script");
		if (armC.moved === 0 && written.readback_true === 0 && written.threw === 0) {
			fail("ARM C INVALID: not one tracked belt moved, and the flag did not stick on any of them. A clone " +
				"whose loop has saturated is still for a lawful reason, so this window cannot tell a no-op flag " +
				"from a stopped world. F2 is NOT measured this run.");
			return;
		}
		verdict("F2", "disabled_by_script = true on a transport-belt is a SILENT NO-OP (readback false, lines keep moving)",
			(written.readback_true === 0 && written.threw === 0 && armC.moved > 0) ? "REPRODUCED" : "DIVERGED",
			`${written.wrote} belts written, ${written.threw} threw, readback true on ${written.readback_true}; ` +
			`${armC.moved}/${armC.tracked} carrying belts still moved over ${armC.window_ticks} ticks`);
		const restored = nums(lua(PRE + `
			local cleared, threw = 0, 0
			for _, e in pairs(belts()) do
			  if pcall(function() e.disabled_by_script = false end) then cleared = cleared + 1
			  else threw = threw + 1 end
			end
			return { success = true, cleared = cleared, threw = threw }`), ["cleared", "threw"]);
		if (restored.threw > 0) say(`  note: clearing the flag threw on ${restored.threw} belt(s)`);

		say("\n=== ARM D: circuit_enable_disable + a FALSE condition, NO wire ===");
		if (!Array.isArray(armA.moved_units) || armA.moved_units.length === 0) {
			throw new Error(`ARM A returned no moved-belt list to draw a wire set from: ${JSON.stringify(armA.moved_units)}`);
		}
		let priorMovers = armA.moved_units;
		let freshMovers = armC.moved_units ?? [];
		let control = { moved: armC.control_moved, tracked: armC.control_moved + armC.control_still };
		let attempt = 1;
		let retries = 0;
		let arm = null;
		while (arm === null) {
			const candidates = buildCandidatePool({ priorMovers, freshMovers });
			say(`  candidate pool: ${candidates.pool.length} belt(s) — ${candidates.persisted} moved in BOTH of ` +
				`the last two windows, ${candidates.freshOnly} in the freshest window only, ` +
				`${candidates.staleDropped} stale mover(s) dropped`);
			const outcome = candidates.pool.length === 0
				? { ok: false, failure: "no-selection", control,
					message: "ARM D/E INVALID: not one belt moved in the window before arming, so there is no " +
						"candidate to arm. The circuit fact is NOT measured this run." }
				: await runCircuitArm(attempt, candidates.pool, control);
			if (outcome.ok) { arm = outcome; break; }
			if (outcome.terminal) { fail(outcome.message); return; }
			const plan = planNextAttempt({ attempt, failure: outcome.failure, control: outcome.control });
			say(`  !! ARM D/E attempt ${attempt} of ${ARM_ATTEMPT_LIMIT} INVALID (${outcome.failure}) -> ` +
				`${plan.action}: ${plan.reason}`);
			if (plan.action === "invalid") {
				fail(`${outcome.message} [attempt ${attempt} of ${ARM_ATTEMPT_LIMIT}, ${retries} retry(ies) spent; ` +
					`${plan.reason}]`);
				return;
			}
			retries += 1;
			attempt += 1;
			if (plan.action === "reclone") {
				const jammed = clones.at(-1);
				await cloneFixture(source.index, source.name);
				dropClone(jammed);
				const rerun = lua(PRE + "p.paused = false return { success = true, paused = p.paused }");
				if (rerun.paused !== false) throw new Error("retry clone did not unpause; the arm cannot be read");
				await L.sleep(2000);
				const qualified = await snapshotAndMeasure(`retry clone qualification (attempt ${attempt})`);
				priorMovers = [];
				freshMovers = qualified.moved_units ?? [];
				control = { moved: qualified.control_moved,
					tracked: qualified.control_moved + qualified.control_still };
			} else {
				const disarmed = nums(lua(DISARM), ["cleared", "missing"]);
				say(`  disarmed the previous set before re-selecting: ${JSON.stringify(disarmed)}`);
				priorMovers = freshMovers;
				freshMovers = outcome.armD.moved_units ?? [];
				control = outcome.control;
			}
		}
		const { selection, statusNoWire, armD, narrowed } = arm;
		say(`  ARM D read on attempt ${attempt} of ${ARM_ATTEMPT_LIMIT} (${retries} retry(ies) spent)`);

		say("\n=== ARM E: the same belts, now with a REAL red wire ===");
		const wired = nums(lua(PRE + `
			local m = by_unit()
			local connected, failed = 0, 0
			for _, pr in ipairs(st.wire_pairs or {}) do
			  local a, b = m[pr.belt], m[pr.partner]
			  if a and b and a.get_wire_connector(defines.wire_connector_id.circuit_red, true)
			      .connect_to(b.get_wire_connector(defines.wire_connector_id.circuit_red, true)) then
			    connected = connected + 1
			  else failed = failed + 1 end
			end
			return { success = true, connected = connected, failed = failed }`), ["connected", "failed"]);
		await L.sleep(1000);
		const statusWired = lua(FROZEN_STATUS);
		say(`  connected=${wired.connected} failed=${wired.failed} status(wired)=${JSON.stringify(statusWired.statuses)}`);
		const armE = await snapshotAndMeasure("ARM E armed + wired");

		const noWireIgnored = statusNoWire.statuses?.working === selection.selected && armD.frozen_moved > 0;
		const wireFroze = statusWired.statuses?.disabled_by_control_behavior === narrowed.kept
			&& armE.frozen_moved === 0 && wired.failed === 0;
		verdict("F3", "the one measured belt freeze is circuit enable/disable, and it needs a REAL wire",
			(noWireIgnored && wireFroze) ? "REPRODUCED" : "DIVERGED",
			`arm attempt ${attempt} of ${ARM_ATTEMPT_LIMIT}, ${retries} retry(ies) spent. ` +
			`no wire: status=${JSON.stringify(statusNoWire.statuses)}, ` +
			`${armD.frozen_moved}/${armD.frozen_moved + armD.frozen_still} armed belts moved over ` +
			`${armD.window_ticks} ticks. wired (${wired.connected} red pair(s), ${wired.failed} failed): ` +
			`status=${JSON.stringify(statusWired.statuses)}, ` +
			`${armE.frozen_moved}/${narrowed.kept} of the SAME belts moved over ${armE.window_ticks} ticks`);
		say(`  context (not a verdict input): the rest of the clone measured ` +
			`${armE.control_moved}/${armE.control_moved + armE.control_still} moving while the wired belts were ` +
			"disabled — a saturated loop jams behind a stopped belt, so this number is not a valid control arm");
	} catch (error) {
		console.error(error.stack || error.message);
		fail(`rung aborted: ${error.message}`);
	} finally {
		let swept = null;
		try {
			const deleted = L.lua(HOST, `
				local ours = { ${clones.map(name => `['${name}'] = true`).join(", ")} }
				local removed, strays = 0, 0
				for _, pl in pairs(game.forces.player.platforms) do
				  if pl.valid and pl.name:sub(1, 11) == 'beltfreeze-' then
				    if ours[pl.name] then
				      if pl.surface and pl.surface.valid then game.delete_surface(pl.surface) end
				      removed = removed + 1
				    else strays = strays + 1 end
				  end
				end
				storage.__belt_freeze_rung = nil
				return { success = true, removed = removed, strays = strays }`);
			say(`cleanup: delete_surface issued for ${JSON.stringify(deleted)}`);
			if (deleted.strays > 0) {
				say(`cleanup: ${deleted.strays} other beltfreeze-* platform(s) left untouched — they belong to ` +
					"another run; sweep them with tools/tests/cleanup-test-surfaces.ps1");
			}
			await L.sleep(5000);
			swept = L.lua(HOST, `
				local ours = { ${clones.map(name => `['${name}'] = true`).join(", ")} }
				local leftover = 0
				for _, pl in pairs(game.forces.player.platforms) do
				  if pl.valid and ours[pl.name] then leftover = leftover + 1 end
				end
				return { success = true, leftover = leftover,
				  storage_cleared = storage.__belt_freeze_rung == nil,
				  jobs = table_size(storage.async_jobs or {}),
				  locks = table_size(storage.locked_platforms or {}),
				  holds = table_size(storage.destination_holds or {}),
				  tick_paused = game.tick_paused == true }`);
		} catch (error) {
			console.error(error.stack || error.message);
			fail(`cleanup RCON failed — ${clones.join(", ")} may still be on the cluster; ` +
				"sweep with tools/tests/cleanup-test-surfaces.ps1");
		}
		say(`\ncleanup: ${JSON.stringify(swept)}`);
		if (swept === null || swept.success !== true) fail(`cleanup did not answer: ${JSON.stringify(swept)}`);
		else {
			if (swept.leftover !== 0) {
				fail(`${swept.leftover} of this run's clone(s) (${clones.join(", ")}) are still on the cluster ` +
					"after delete_surface");
			}
			if (swept.storage_cleared !== true) fail("storage.__belt_freeze_rung was not cleared");
			for (const key of ["jobs", "locks", "holds"]) {
				const before = baseline ? baseline[key] : 0;
				if (swept[key] > before) {
					fail(`${key}=${swept[key]} after cleanup, ${before} before the run — this rung added ${key}`);
				} else if (swept[key] !== 0) {
					say(`  note: ${key}=${swept[key]}, unchanged from before this run — not this rung's to clear`);
				}
			}
			if (swept.tick_paused !== false && !(baseline && baseline.tick_paused)) fail("game left tick-paused");
		}
	}

	if (verdicts.length !== EXPECTED_FACTS) {
		fail(`only ${verdicts.length} of ${EXPECTED_FACTS} facts reached a verdict — the run is incomplete, ` +
			"not green");
	}
	say("\n=== verdicts ===");
	for (const v of verdicts) say(`${v.id} ${v.status}  ${v.claim}\n      ${v.evidence}`);
	if (problems.length) {
		say(`\nbelt-freeze: FAILED (${problems.length} problem(s))`);
		for (const p of problems) say(`  - ${p}`);
	} else {
		say(`\nbelt-freeze: ${verdicts.length}/${EXPECTED_FACTS} facts REPRODUCED at this pin, zero leftovers`);
	}
}

await main();
