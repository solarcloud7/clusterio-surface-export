-- Lifecycle engine: executes per-fixture lifecycle blocks (P2 of the pad lifecycle framework).
-- A lifecycle block = {version=1, mutable={anchorName,...}, setup={op,...}, act, verify={check,...}}.
-- Rides the roster (storage.surface_export_test_roster); the runner drives setup -> act -> verify ->
-- cleanup. The manifest validator (tests/lab-gallery/manifest.mjs validateLifecycle) is the schema
-- authority; this engine re-checks the DI-critical arm_hook allowlist in-game (defense in depth).
--
-- Detail strings are PLAIN concatenation and short — a large LocalisedString hits the engine's hard
-- parameter cap (a LocalisedString is capped at 20 parameters). Every pcall here surfaces its error (returned or logged), never
-- swallowed (lint:pcall-logging). Removal uses game.delete_surface via callers, never platform.destroy.
local FixtureMeters = require("modules/surface_export/utils/fixture-meters")

local LifecycleEngine = {}

-- Allowlist mirror of scripts/fail-safe-hooks.mjs (FAIL_SAFE_HOOKS + NON_DESTRUCTIVE_HOOKS). The
-- manifest validator blocks non-allowlisted hooks node-side; this is the in-game defense-in-depth
-- copy so an arm_hook that somehow reaches the engine is refused loudly.
local ALLOWED_HOOKS = {
	test_force_item_loss = true,
	test_force_fluid_loss = true,
	test_force_validation_failure = true,
	test_force_entity_failure = true,
	test_force_census_omission = true,
	test_defer_clone_activation = true,
}

local VAULT_X, VAULT_Y, VAULT_ENTITY = 12.5, -16.5, "steel-chest"

-- Resolve an anchor NAME to (x, y, entity_name). "vault" is the fixed shared steel-chest on
-- lab-omnibus-state-v1; every other name is looked up in fixture.anchors by its `name` field.
local function anchor_pos(fixture, name)
	if name == "vault" then return VAULT_X, VAULT_Y, VAULT_ENTITY end
	for _, a in ipairs(fixture.anchors or {}) do
		if a.name == name then return a.x, a.y, a.entity end
	end
	-- Fall back to the anchor's declared ENTITY. Most fixtures' anchors carry no `name` (only the
	-- scratch anchors of sabotage fixtures do), which left them unreferenceable — and that gap is
	-- what pushed a check into restating the prototype name itself, the duplication a typo could then
	-- exploit. Matching the entity keeps the reference inside the fixture's own closed anchor set: an
	-- unknown value fails loud here, it never reaches find_entities_filtered. Ambiguity is refused
	-- rather than guessed, for the same reason resolve_area_entity refuses a multi-match.
	local found_x, found_y, found_entity, matches = nil, nil, nil, 0
	for _, a in ipairs(fixture.anchors or {}) do
		if a.entity == name then
			matches = matches + 1
			found_x, found_y, found_entity = a.x, a.y, a.entity
		end
	end
	if matches == 1 then return found_x, found_y, found_entity end
	if matches > 1 then return nil, nil, nil, matches end
	return nil
end

-- Find the entity of `entity_name` in a ±0.6 box around (x, y). nil if absent.
local function find_at(surface, entity_name, x, y)
	if not entity_name then return nil end
	return surface.find_entities_filtered({
		name = entity_name,
		area = { { x - 0.6, y - 0.6 }, { x + 0.6, y + 0.6 } },
	})[1]
end

-- Resolve a setup/verify locator's target anchor entity. `target` is "anchor:<n>", "vault", or a
-- bare anchor name. Returns entity, err_detail.
local function resolve_target_entity(surface, fixture, target, dx)
	dx = dx or 0
	local name = tostring(target):gsub("^anchor:", "")
	local x, y, ename, ambiguous = anchor_pos(fixture, name)
	if not x then
		if ambiguous then
			return nil, string.format("anchor '%s' matches %d anchors on this fixture — name one of them "
				.. "explicitly (add a `name` to the anchor)", name, ambiguous)
		end
		return nil, "anchor '" .. name .. "' not in fixture anchors"
	end
	local entity = find_at(surface, ename, x + dx, y)
	if not entity then
		return nil, "entity " .. tostring(ename) .. " missing at (" .. (x + dx) .. "," .. y .. ")"
	end
	return entity
end

-- First inventory a container-like entity exposes (chest main, else its output inventory).
local function main_inventory(entity)
	return entity.get_inventory(defines.inventory.chest) or entity.get_output_inventory() or nil
end

-- === setup ops ================================================================================

local function op_spawn_item(surface, fixture, ctx, op, index)
	local entity, err = resolve_target_entity(surface, fixture, op.into, 0)
	if not entity then return false, "spawn_item: " .. err end
	local stack = { name = op.name, count = op.count }
	if op.quality then stack.quality = op.quality end
	local inserted = entity.insert(stack)
	if inserted ~= op.count then
		return false, "spawn_item: inserted " .. inserted .. " of " .. op.count .. " " .. op.name
	end
	local readback = entity.get_item_count(op.name)
	if readback ~= op.count then
		return false, "spawn_item: readback " .. readback .. " ~= " .. op.count .. " " .. op.name
	end
	local captured = { count = readback }
	if op.spoil_percent ~= nil then
		local inv = main_inventory(entity)
		local target_stack
		if inv then
			for i = 1, #inv do
				local s = inv[i]
				if s.valid_for_read and s.name == op.name then target_stack = s break end
			end
		end
		if not target_stack then return false, "spawn_item: no stack to spoil for " .. op.name end
		local ok, set_err = pcall(function() target_stack.spoil_percent = op.spoil_percent end)
		if not ok then return false, "spawn_item: set spoil_percent failed: " .. tostring(set_err) end
		local read_spoil = target_stack.spoil_percent
		if math.abs(read_spoil - op.spoil_percent) > 0.01 then
			return false, "spawn_item: spoil readback " .. read_spoil .. " ~= " .. op.spoil_percent
		end
		captured.spoil = read_spoil
	end
	ctx.captured[index] = captured
	return true
end

local function op_spawn_fluid(surface, fixture, ctx, op)
	local entity, err = resolve_target_entity(surface, fixture, op.into, 0)
	if not entity then return false, "spawn_fluid: " .. err end
	local inserted = entity.insert_fluid({ name = op.name, amount = op.amount })
	if math.abs(inserted - op.amount) > 0.001 then
		return false, "spawn_fluid: inserted " .. inserted .. " of " .. op.amount .. " " .. op.name
	end
	local readback = entity.get_fluid_count(op.name)
	if math.abs(readback - op.amount) > 0.001 then
		return false, "spawn_fluid: readback " .. readback .. " ~= " .. op.amount .. " " .. op.name
	end
	return true
end

local function op_set_stack_field(surface, fixture, ctx, op)
	local entity, err = resolve_target_entity(surface, fixture, op.locator and op.locator.anchor, 0)
	if not entity then return false, "set_stack_field: " .. err end
	local inv = main_inventory(entity)
	local stack
	if inv then for i = 1, #inv do if inv[i].valid_for_read then stack = inv[i] break end end end
	if not stack then return false, "set_stack_field: no stack in target" end
	local ok, set_err = pcall(function() stack[op.field] = op.value end)
	if not ok then return false, "set_stack_field: write failed: " .. tostring(set_err) end
	local readback = stack[op.field]
	if readback ~= op.value then
		return false, "set_stack_field: readback " .. tostring(readback) .. " ~= " .. tostring(op.value)
	end
	return true
end

local function op_set_health(surface, fixture, ctx, op)
	local entity, err = resolve_target_entity(surface, fixture, op.locator and op.locator.anchor, 0)
	if not entity then return false, "set_health: " .. err end
	local ok, set_err = pcall(function() entity.health = op.value end)
	if not ok then return false, "set_health: write failed: " .. tostring(set_err) end
	if math.abs((entity.health or -1) - op.value) > 0.01 then
		return false, "set_health: readback " .. tostring(entity.health) .. " ~= " .. tostring(op.value)
	end
	return true
end

local function op_arm_hook(ctx, op)
	if not ALLOWED_HOOKS[op.name] then
		return false, "arm_hook: '" .. tostring(op.name) .. "' is not in the fail-safe allowlist"
	end
	storage.surface_export_config = storage.surface_export_config or {}
	storage.surface_export_config[op.name] = op.value
	ctx.armed_hooks[op.name] = true
	log("[lifecycle] armed hook " .. op.name .. "=" .. tostring(op.value))
	return true
end

local function op_mutate_force(ctx, op)
	local force = game.forces.player
	local old = force[op.prop]
	ctx.restores[#ctx.restores + 1] = { prop = op.prop, value = old }
	local ok, set_err = pcall(function() force[op.prop] = op.value end)
	if not ok then return false, "mutate_force: write failed: " .. tostring(set_err) end
	log("[lifecycle] mutate_force " .. op.prop .. "=" .. tostring(op.value) .. " (was " .. tostring(old) .. ")")
	return true
end

local function op_lua(op)
	log("[lifecycle] lua op: " .. tostring(op.reason))
	local fn, load_err = load(op.code)
	if not fn then return false, "lua: compile failed: " .. tostring(load_err) end
	local ok, run_err = pcall(fn)
	if not ok then return false, "lua: run failed: " .. tostring(run_err) end
	return true
end

-- Run a list of ops (shared by setup and an op-list act). Fails on the first bad op, prefixing the
-- detail with `label` + the 1-based op index. ctx = {armed_hooks={}, restores={}, captured={}}.
-- end_filter (default "source"): only ops whose declared end matches run — dest-end sabotage ops
-- (op.end = "dest") are executed ONLY by the dest instance's lifecycle_dest_setup, never locally.
local function run_ops(surface, fixture, ctx, ops, label, end_filter)
	if type(ops) ~= "table" then return true end
	end_filter = end_filter or "source"
	for index, op in ipairs(ops) do
		if (op["end"] or "source") == end_filter then
		local ok, err
		if op.op == "spawn_item" then
			ok, err = op_spawn_item(surface, fixture, ctx, op, index)
		elseif op.op == "spawn_fluid" then
			ok, err = op_spawn_fluid(surface, fixture, ctx, op)
		elseif op.op == "set_stack_field" then
			ok, err = op_set_stack_field(surface, fixture, ctx, op)
		elseif op.op == "set_health" then
			ok, err = op_set_health(surface, fixture, ctx, op)
		elseif op.op == "arm_hook" then
			ok, err = op_arm_hook(ctx, op)
		elseif op.op == "mutate_force" then
			ok, err = op_mutate_force(ctx, op)
		elseif op.op == "lua" then
			ok, err = op_lua(op)
		else
			ok, err = false, "unknown op '" .. tostring(op.op) .. "'"
		end
		if not ok then return false, label .. " #" .. index .. " " .. tostring(err) end
		end
	end
	return true
end

-- run_setup(surface, fixture, ctx, end_filter) -> ok, err. ctx = {armed_hooks={}, restores={},
-- captured={}}. end_filter defaults to "source" (the local runner and the source instance);
-- "dest" runs only the dest-end sabotage ops.
function LifecycleEngine.run_setup(surface, fixture, ctx, end_filter)
	local lc = fixture.lifecycle
	if not lc then return true end
	return run_ops(surface, fixture, ctx, lc.setup, "setup op", end_filter)
end

-- run_act(surface, fixture, ctx) -> ok, err. Executes an op-list `act` (a local mutation in place of
-- a copy-paste/transfer/clone act). A non-op-list act is a no-op here (the caller drives it).
function LifecycleEngine.run_act(surface, fixture, ctx)
	local lc = fixture.lifecycle
	if not (lc and type(lc.act) == "table") then return true end
	return run_ops(surface, fixture, ctx, lc.act, "act op")
end

-- === verify checks ============================================================================

-- Interior rect of the pad half at fixture.origin, offset by dx (0 = left, 14 = pasted right).
local function pad_area(fixture, dx)
	local o = fixture.origin
	if type(o) ~= "table" then return nil end
	return { { o.x + 1 + dx, o.y }, { o.x + 13 + dx, o.y + 11 } }
end

-- Resolve a physical_read locator to a surface + entity/area context.
local function resolve_read_locator(surface, fixture, locator, dx)
	dx = dx or 0
	if locator.self then
		-- the verify surface itself (platform-kind transfer fixtures: the arrived scratch platform)
		return { kind = "self", surface = surface }
	elseif locator.platform then
		local psurface = FixtureMeters.surface_for_platform(locator.platform)
		return { kind = "platform", platform_name = locator.platform, surface = psurface }
	elseif locator.area then
		return { kind = "area", surface = surface, area = pad_area(fixture, dx) }
	elseif locator.anchor then
		local entity, err = resolve_target_entity(surface, fixture, locator.anchor, dx)
		return { kind = "anchor", surface = surface, entity = entity, err = err }
	end
	return { kind = "none", err = "locator has no anchor/area/platform" }
end

-- Property paths are walked by INDEXING only; the cap bounds a malformed roster, not real fixtures
-- (the deepest measured live path, "burner.currently_burning.name.name", is 4).
local PROPERTY_MAX_DEPTH = 8

-- Save/load ULP allowance, mirroring DOUBLE_EPSILON in tests/lab-gallery/batch-lifecycle.mjs.
local DOUBLE_EPSILON = 1e-9

local function compare_op(op, actual, expected)
	if op == "eq" then return actual == expected end
	-- `approx` exists because engine floats do not survive a round-trip bit-exact and the fixtures
	-- already record that: omnibus-midcraft-progress pins 0.7000000000000005 and no-tick-sync-frozen
	-- pins 0.42000000000000004. A bare `eq` on those fails on ULP noise, and the tempting "fix" is to
	-- loosen the comparison — so the epsilon is a named constant equal to the Node side's, NOT a
	-- widened eq. `eq` keeps exact semantics for every existing check.
	if op == "approx" then
		return type(actual) == "number" and type(expected) == "number"
			and math.abs(actual - expected) <= DOUBLE_EPSILON
	end
	if op == "ge" then return type(actual) == "number" and actual >= expected end
	if op == "le" then return type(actual) == "number" and actual <= expected end
	if op == "between" then
		return type(actual) == "number" and type(expected) == "table"
			and actual >= expected[1] and actual <= expected[2]
	end
	return false
end

--- Resolve exactly ONE entity of `name` inside an area locator's rect.
---
--- Fails loud on BOTH zero and 2+. The 2+ case is the one that matters: picking `found[1]` out of a
--- multi-match reads an ARBITRARY entity, so a fixture with two same-name entities silently asserts
--- against whichever the engine happened to return first — a pass that means nothing, or a flake.
--- That is the name-vs-unique-identity rule the repo already applies to platform lookups, and the
--- reason this is a shared helper rather than two copies: `infinity_pipe_filter` and `property` both
--- need it, and a parity to maintain is a parity that drifts.
--- @return LuaEntity|nil, string|nil
local function resolve_area_entity(loc, name, what)
	-- find_entities_filtered THROWS on an unknown prototype name, and an uncaught throw here escapes
	-- lifecycle_verify entirely — aborting every REMAINING check in the fixture rather than failing
	-- this one. That asymmetry is the bug: the `path` walk one branch down is carefully fail-closed
	-- per-check, so a typo'd `entity_name` must be too. Both are external roster data.
	local ok, found = pcall(function()
		return loc.surface.find_entities_filtered({ area = loc.area, name = name })
	end)
	if not ok then
		return nil, string.format("entity_name %q is not a valid prototype for %s: %s",
			tostring(name), what, tostring(found))
	end
	if #found == 0 then
		return nil, string.format("no %s in pad area for %s", tostring(name), what)
	end
	if #found > 1 then
		return nil, string.format("%d %s entities in pad area for %s — the locator does not identify one; "
			.. "narrow the area or use an anchor", #found, tostring(name), what)
	end
	return found[1]
end

-- Read the numeric value a physical_read requests from a resolved locator.
local function perform_read(loc, check)
	local read = check.read
	if read == "platform_present" then
		return loc.surface ~= nil and 1 or 0
	end
	if read == "surface_entity_count" then
		if not loc.surface then return nil, "no surface for surface_entity_count" end
		return #loc.surface.find_entities_filtered({})
	end
	-- STRUCTURE count for live-factory fixtures — a DELEGATION to the canonical counter (same
	-- pattern as belt_stats below): FixtureMeters.count_stable_entities carries the rationale and
	-- the transient-class list; a second copy here would drift.
	if read == "surface_entity_count_stable" then
		if not loc.surface then return nil, "no surface for surface_entity_count_stable" end
		return FixtureMeters.count_stable_entities(loc.surface)
	end
	-- Fluid-segment stats over the pad area — DELEGATION to the canonical meter (belt_stats
	-- pattern). segmentCount is the underground-pipe PAIRING detector; see the meter's header.
	if read == "fluid_stats" then
		if loc.kind ~= "area" then return nil, "fluid_stats needs an area locator" end
		local ok, reading = pcall(FixtureMeters.measure_fluid_segments, loc.surface, loc.area)
		if not ok then return nil, "fluid_stats meter error: " .. tostring(reading) end
		local value = reading[check.field]
		if value == nil then return nil, "fluid_stats has no field " .. tostring(check.field) end
		return value
	end
	if read == "entity_present" then
		if loc.kind == "area" then
			return #loc.surface.find_entities_filtered({ area = loc.area })
		end
		return loc.entity ~= nil and 1 or 0
	end
	-- INFINITY PIPE FILTER. Works on an AREA locator (find the pipe in the pad rect) or an anchor.
	-- The filter is a TABLE {name, percentage, temperature, mode}, and compare_op only does scalar
	-- comparison — so `field` selects which member to assert (default "name"). Assert temperature
	-- as its own check when it matters: a plasma pipe at 1e6 K is not the same fixture as one at
	-- default temperature, and name-only would not notice.
	--
	-- A REGRESSED filter reads nil here, so `eq` fails and the fixture goes RED. That is the teeth:
	-- nothing else in the suite can see this, because a filter is a SETTING, not contents, and the
	-- exact gate counts only items and fluids.
	if read == "infinity_pipe_filter" then
		local pipe = loc.entity
		if loc.kind == "area" then
			local resolved, err = resolve_area_entity(loc, "infinity-pipe", "infinity_pipe_filter")
			if not resolved then return nil, err end
			pipe = resolved
		end
		if not pipe then return nil, loc.err or "no entity for infinity_pipe_filter" end
		local ok, filter = pcall(function() return pipe.get_infinity_pipe_filter() end)
		if not ok then return nil, "get_infinity_pipe_filter threw: " .. tostring(filter) end
		if not filter then return nil, "infinity-pipe has NO filter (dropped?)" end
		local field = check.field or "name"
		return filter[field]
	end

	-- BELT LANE STATS — the belt law's aggregate readings (beltCount / steadyItems / maxStack /
	-- overpackedLanes / loaderFilterIron / ...), read by THE canonical instrument:
	-- FixtureMeters.measure_belt_combined. Deliberately a DELEGATION, not a reimplementation — the
	-- definitions ("over-packed = a transport line holding >4 items") must have exactly one home, and
	-- the paste fingerprint already uses that home. This is what carries a belt fixture's FULL law to
	-- a transfer DESTINATION: until 2026-07-26 the dest asserted only item counts, and structure
	-- infidelity rode through green (the 37-vs-13 over-compression incident).
	if read == "belt_stats" then
		if loc.kind ~= "area" then return nil, "belt_stats requires an area locator (the pad rect)" end
		local field = check.field
		if type(field) ~= "string" or field == "" then return nil, "belt_stats requires a `field` string" end
		local ok, reading = pcall(FixtureMeters.measure_belt_combined, loc.surface, loc.area)
		if not ok then return nil, "belt_stats meter threw: " .. tostring(reading) end
		local value = reading[field]
		if value == nil then
			local keys = {}
			for k in pairs(reading) do keys[#keys + 1] = k end
			table.sort(keys)
			return nil, string.format("belt_stats has no field %q (fields: %s)", field, table.concat(keys, ", "))
		end
		return value
	end

	-- DECLARATIVE PROPERTY READ — the one read kind that removes the need for new read kinds.
	--
	-- `path` is a dotted string naming a read-only property chain on the resolved entity:
	--   "temperature"                          -> 500
	--   "bonus_progress"                       -> 0.5
	--   "burner.remaining_burning_fuel"        -> 2000000
	--   "burner.currently_burning.name.name"   -> "solid-fuel"
	-- (all four measured live on the 2.1.11 gallery, 2026-07-26, matching their fingerprints).
	--
	-- WHY IT EXISTS. Asserting a new engine property used to cost FOUR files: a branch here, an entry
	-- in manifest.mjs PHYSICAL_READS, a count bump in manifest.test.mjs, and the fixture itself. That
	-- is one read kind declared in three places. With this, a fixture asserting a property the engine
	-- already exposes is a manifest.json edit ALONE.
	--
	-- SECURITY. The roster crosses `json_to_table_compat` specifically so an arbitrary payload cannot
	-- inject Lua, which makes the validation HERE load-bearing — this is data from outside, and a
	-- Node-side check alone would not be a boundary. Keys must match a strict identifier charset,
	-- depth is capped, and only INDEXING ever happens: nothing is called, so there is no argument and
	-- no mutation surface. (Reading `entity.destroy` yields a function value; it is never invoked.)
	--
	-- FAIL-CLOSED. A step that THROWS and a step that resolves NIL are both red, with distinguishable
	-- messages. An invalid LuaEntity throws on property access, while a real-but-unset property reads
	-- nil — collapsing those would let a typo'd path masquerade as data loss, the exact false-finding
	-- class the payload inspector had to be fixed for.
	if read == "property" then
		local path = check.path
		if type(path) ~= "string" or path == "" then
			return nil, "property read requires a non-empty dotted `path` string"
		end
		-- The entity comes from the fixture's own ANCHOR, never from a name restated on the check.
		-- An earlier cut took an `entity_name` string and passed it straight to find_entities_filtered,
		-- which meant the prototype name existed in two places (here and anchors[].entity) and a typo
		-- was possible — so it grew a validator, a pcall guard, and a red tooth to survive one. All
		-- three are deleted with the duplication: `locator.anchor` names an entry in THIS fixture's
		-- anchors, a closed local set that fails loud ("anchor 'x' not in fixture anchors"), and
		-- anchor_pos hands back the prototype name the fixture already declared. Nothing to mistype.
		local entity = loc.entity
		if not entity then
			return nil, loc.err or "property read needs an anchor locator (the anchor carries the entity)"
		end

		local cursor, depth = entity, 0
		for key in string.gmatch(path, "[^%.]+") do
			depth = depth + 1
			if depth > PROPERTY_MAX_DEPTH then
				return nil, string.format("property path %q exceeds max depth %d", path, PROPERTY_MAX_DEPTH)
			end
			if not string.match(key, "^[A-Za-z_][A-Za-z0-9_]*$") then
				return nil, string.format("property path %q has illegal segment %q (identifiers only)", path, key)
			end
			local ok, value = pcall(function() return cursor[key] end)
			if not ok then
				-- The engine's own message is the precise one and is quoted verbatim; do not guess a
				-- cause alongside it. Measured 2026-07-26: a typo'd key reads "LuaEntity doesn't contain
				-- key temperature_bogus", NOT nil — so an unknown property lands here, not in the nil
				-- branch below. Both are red either way; this note exists so the next reader does not
				-- assume a typo is the nil case.
				return nil, string.format("property path %q THREW at %q: %s", path, key, tostring(value))
			end
			if value == nil then
				return nil, string.format("property path %q resolved NIL at %q — the property is unset, or the "
					.. "path is wrong; either way this is not a pass", path, key)
			end
			cursor = value
		end

		local kind = type(cursor)
		if kind ~= "number" and kind ~= "string" and kind ~= "boolean" then
			return nil, string.format("property path %q ended on a %s; comparison needs a scalar "
				.. "(extend the path to reach one, e.g. \"...name.name\")", path, kind)
		end
		return cursor
	end

	if loc.kind == "anchor" and not loc.entity then return nil, loc.err end
	if read == "item_count" then
		if loc.kind == "area" then
			local total = 0
			for _, e in pairs(loc.surface.find_entities_filtered({ area = loc.area })) do
				total = total + e.get_item_count(check.item)
			end
			return total
		end
		return loc.entity.get_item_count(check.item)
	elseif read == "held" then
		local held = loc.entity.held_stack
		return (held and held.valid_for_read) and held.count or 0
	elseif read == "crafting_progress" then
		return loc.entity.crafting_progress
	elseif read == "spoil_percent" then
		local inv = main_inventory(loc.entity)
		if inv then
			for i = 1, #inv do
				local s = inv[i]
				if s.valid_for_read and (not check.item or s.name == check.item) then return s.spoil_percent end
			end
		end
		return nil, "no stack to read spoil_percent"
	elseif read == "fluid" then
		local total = 0
		for i = 1, loc.entity.fluids_count do
			local f = loc.entity.get_fluid(i)
			if f and (not check.item or f.name == check.item) then total = total + f.amount end
		end
		return total
	end
	return nil, "unknown read '" .. tostring(read) .. "'"
end

-- monotone baseline = the first captured spoil reading from setup (spawn_item spoil_percent).
local function monotone_baseline(ctx)
	for _, cap in pairs(ctx.captured or {}) do
		if cap.spoil ~= nil then return cap.spoil end
	end
	return 0
end

--- A check's reported name must IDENTIFY it. For most reads the read kind is enough, but a property
--- read's identity is its path: without it, every property check reports as "area.property", so two
--- on one pad produce identical failure names and the message cannot tell you which one broke.
local function read_label(check)
	if check.read == "property" then
		return "property(" .. tostring(check.path) .. ")"
	end
	if check.read == "belt_stats" then
		return "belt_stats(" .. tostring(check.field) .. ")"
	end
	if check.read == "fluid_stats" then
		return "fluid_stats(" .. tostring(check.field) .. ")"
	end
	return tostring(check.read) .. (check.item and ("(" .. check.item .. ")") or "")
end

local function check_physical_read(surface, fixture, ctx, check, dx)
	local loc = resolve_read_locator(surface, fixture, check.locator or {}, dx)
	local where = (check.locator and (check.locator.anchor or check.locator.platform)) or "area"
	local actual, read_err = perform_read(loc, check)
	if read_err then
		return { name = where .. "." .. read_label(check), verdict = "fail", detail = tostring(read_err) }
	end
	local name = where .. "." .. read_label(check)
	local pass, detail
	if check.op == "monotone" then
		local baseline = monotone_baseline(ctx)
		pass = type(actual) == "number" and actual >= baseline and actual < 1.0
		detail = "actual=" .. tostring(actual) .. " baseline=" .. tostring(baseline)
	else
		pass = compare_op(check.op, actual, check.expected)
		detail = "actual=" .. tostring(actual) .. " " .. tostring(check.op) .. " " .. tostring(check.expected)
	end
	return { name = name, verdict = pass and "pass" or "fail", detail = detail }
end

-- run_verify(surface, fixture, ctx, extra) -> {verdict="pass"|"fail", checks={{name,verdict,detail}...}}.
-- extra.dx (default 0) selects the pad half read for anchor/area locators. extra.end_filter (when
-- set) runs only checks whose declared end matches — the orchestrator runs "dest" checks on the
-- destination instance and "source" checks against the preserved source scratch after a refused
-- transfer. fingerprint checks are the caller's job (run-tests keeps its existing compare).
function LifecycleEngine.run_verify(surface, fixture, ctx, extra)
	local lc = fixture.lifecycle
	local dx = (extra and extra.dx) or 0
	local end_filter = extra and extra.end_filter
	local checks = {}
	local verdict = "pass"
	if not (lc and type(lc.verify) == "table") then return { verdict = verdict, checks = checks } end
	for _, check in ipairs(lc.verify) do
		local result
		if end_filter and (check["end"] or "dest") ~= end_filter then
			result = nil -- other end's check; that end's runner owns it
		elseif check.check == "physical_read" then
			result = check_physical_read(surface, fixture, ctx, check, dx)
		elseif check.check == "report_field" then
			result = { name = "report_field", verdict = "skipped", detail = "report_field is orchestrator-side" }
		elseif check.check == "log_line" then
			result = { name = "log_line", verdict = "skipped", detail = "log_line is orchestrator-side" }
		elseif check.check == "census_pass" then
			result = { name = "census_pass", verdict = "skipped", detail = "census_pass is orchestrator-side" }
		elseif check.check == "fingerprint" then
			result = nil -- caller owns the fingerprint compare
		else
			result = { name = tostring(check.check), verdict = "fail", detail = "unknown check" }
		end
		if result then
			checks[#checks + 1] = result
			if result.verdict == "fail" then verdict = "fail" end
		end
	end
	return { verdict = verdict, checks = checks }
end

-- === cleanup / reset ==========================================================================

-- cleanup(ctx): disarm armed hooks, restore mutated force props. ALWAYS called by callers
-- (pcall-wrapped). Logs each action; surfaces nothing silently.
function LifecycleEngine.cleanup(ctx)
	if not ctx then return end
	for name in pairs(ctx.armed_hooks or {}) do
		if storage.surface_export_config then storage.surface_export_config[name] = nil end
		log("[lifecycle] cleanup disarmed hook " .. name)
	end
	for _, r in ipairs(ctx.restores or {}) do
		game.forces.player[r.prop] = r.value
		log("[lifecycle] cleanup restored force " .. r.prop .. "=" .. tostring(r.value))
	end
end

-- reset_mutable(surface, fixture, dx): empty each lifecycle.mutable anchor's inventory at anchor
-- pos + dx offset, so a lifecycle setup starts from a clean container on both halves.
function LifecycleEngine.reset_mutable(surface, fixture, dx)
	dx = dx or 0
	local lc = fixture.lifecycle
	if not (lc and type(lc.mutable) == "table") then return end
	for _, name in ipairs(lc.mutable) do
		local x, y, ename = anchor_pos(fixture, name)
		if x then
			local entity = find_at(surface, ename, x + dx, y)
			if entity then
				local inv = main_inventory(entity)
				if inv then inv.clear() end
				-- fluid-holding mutable anchors (storage tanks) reset via clear_fluid_inside;
				-- intentional probe: errors only on fluidbox-less entities, where there is
				-- nothing to clear (a nil-op, not a swallowed failure)
				pcall(function() entity.clear_fluid_inside() end)
			end
		end
	end
end

return LifecycleEngine
