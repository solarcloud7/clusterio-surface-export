-- FactorioSurfaceExport - Fluid-segment law self-test (remote)
--
-- Re-certification instrument for the Factorio 2.1 fluid-segment laws that the fluid registry
-- (export_scanners/fluid-registry.lua), the census (validators/surface-counter.lua), and the
-- restoration path (import_phases/fluid_restoration.lua) all depend on. Every law here was measured
-- LIVE on Factorio 2.1.11 (fluid-law experiments, 2026-07-21, NOTEBOOK); this selftest reproduces
-- those measurements FROM CODE so an engine bump re-certifies (or refutes) each law in one run. The
-- measured 2.1.11 reference values are baked into each assertion/comment as the baseline a future run
-- compares against.
--
-- Debug-gated: refuses with {ok=false, err="debug_mode off"} unless
-- storage.surface_export_config.debug_mode. Builds ONE scratch space platform
-- ("fluid-law-selftest-scratch"), runs every experiment, then GUARANTEES teardown even if an
-- experiment throws (each row body is pcall-isolated so one engine throw cannot hide later laws).
-- Zero-leftover is mandatory on the shared cluster: a stale scratch from a prior crashed run is swept
-- at start, and the platform this run creates is torn down through the HELD reference.
--
-- teardown_clean note: game.delete_surface is DEFERRED to end of tick (Pitfall #19; the belt selftest
-- and the delete-platform memory both rely on the surface staying enumerable within the same
-- execution), so a same-execution rescan would still see the platform. teardown_clean therefore means
-- "delete issued without error"; the driver (tests/integration/fluid-segment-law/run-tests.mjs) does
-- the authoritative zero-leftover count on the next (later) tick.

local SCRATCH_NAME = "fluid-law-selftest-scratch"

local function find_scratch_platforms()
	local out = {}
	for _, platform in pairs(game.forces.player.platforms) do
		if platform.valid and platform.name == SCRATCH_NAME then
			out[#out + 1] = platform
		end
	end
	return out
end

-- Sweep leftovers from a PRIOR crashed run only. Those deletions finalized at that run's end-of-tick,
-- so by this (later) tick they are gone from force.platforms; sweeping here cannot double-delete the
-- platform this run creates (that one is torn down via the held reference below).
local function sweep_prior_leftovers()
	local swept = 0
	for _, platform in ipairs(find_scratch_platforms()) do
		if platform.surface and platform.surface.valid then
			game.delete_surface(platform.surface)
			swept = swept + 1
		end
	end
	return swept
end

local function pipe(surface, force, x, y)
	return surface.create_entity({ name = "pipe", position = { x, y }, force = force })
end

local function seg_amount(entity, box_index)
	local seg = entity.get_fluid_segment_fluid(box_index)
	return seg and seg.amount or nil
end

local function seg_id(entity, box_index)
	if not entity.has_fluid_segment(box_index) then return nil end
	return entity.get_fluid_segment_id(box_index)
end

-- get_fluid_box_prototype(i) returns a single LuaFluidBoxPrototype or an array of them (a box with
-- multiple prototypes, e.g. a fluid-energy-source box). Normalize to the production_type string.
local function box_production_type(entity, box_index)
	local proto = entity.get_fluid_box_prototype(box_index)
	if not proto then return "nil" end
	if proto.production_type then return proto.production_type end
	if proto[1] and proto[1].production_type then return proto[1].production_type end
	return "unknown"
end

-- (a) Control: a pipe row forms ONE segment; the segment total is EXACT while per-storage reads are
-- float32 capacity shares. Measured 2.1.11: segment == 1000 (==, no epsilon); share sum ==
-- 999.9999997615814 (|delta| ~ 2.4e-7). A storage-tank alone forms a segment; a 500 insert reads 500.
local function exp_pipe_and_tank_control(surface, force)
	local pipes = {}
	for k = 0, 11 do
		local p = pipe(surface, force, -16.5 + k, -18.5)
		if not (p and p.valid) then
			return { ok = false, detail = "pipe " .. k .. " create failed" }
		end
		pipes[#pipes + 1] = p
	end
	local inserted = pipes[1].insert_fluid({ name = "water", amount = 1000 })
	local segment = seg_amount(pipes[6], 1) -- read from an arbitrary member
	local share_sum = 0
	for _, p in ipairs(pipes) do
		local f = p.get_fluid(1)
		share_sum = share_sum + (f and f.amount or 0)
	end
	local ok_segment = segment == 1000 -- exact, no epsilon
	local ok_shares = math.abs(share_sum - 1000) <= 1e-5 -- float32 shares (measured |d| ~ 2.4e-7)

	local tank = surface.create_entity({ name = "storage-tank", position = { 12, -18 }, force = force })
	local tank_pipe = pipe(surface, force, 14.5, -18)
	local tank_segment
	local ok_tank = false
	if tank and tank.valid then
		tank.insert_fluid({ name = "water", amount = 500 })
		tank_segment = seg_amount(tank, 1)
		ok_tank = tank_segment == 500
	end

	return {
		ok = ok_segment and ok_shares and ok_tank,
		detail = string.format(
			"pipe segment=%s(want 1000, ==) share_sum=%.10f(want ~1000, |d|<=1e-5) tank_pipe=%s tank_segment=%s(want 500) inserted=%s",
			tostring(segment), share_sum, tostring(tank_pipe ~= nil), tostring(tank_segment), tostring(inserted)),
	}
end

-- (b) Two thrusters whose WEST fuel ports are joined by an 11-pipe U share ONE fuel segment; the
-- segment total is exact (500) while storages are 10:1 (thruster:pipe) capacity shares. Measured
-- 2.1.11: thruster share 161.290323, pipe share 16.129032 (2*10 + 11*1 = 31 units; 500/31).
local function exp_thruster_pair(surface, force)
	local a = surface.create_entity({ name = "thruster", position = { -10, 20.5 }, force = force })
	local b = surface.create_entity({ name = "thruster", position = { -2, 20.5 }, force = force })
	if not (a and a.valid and b and b.valid) then
		return { ok = false, detail = "thruster create failed (a=" .. tostring(a ~= nil) .. " b=" .. tostring(b ~= nil) .. ")" }
	end
	-- Measured fuel-port geometry: A fuel box1 west port target (-12.5,18.5), B (-4.5,18.5); the U
	-- routes along row 17.5 to avoid the oxidizer box2 ports (rows 20.5/18.5 mirrored).
	local path = {
		{ -12.5, 18.5 }, { -12.5, 17.5 }, { -11.5, 17.5 }, { -10.5, 17.5 }, { -9.5, 17.5 },
		{ -8.5, 17.5 }, { -7.5, 17.5 }, { -6.5, 17.5 }, { -5.5, 17.5 }, { -4.5, 17.5 }, { -4.5, 18.5 },
	}
	local pipes = {}
	for _, pt in ipairs(path) do
		local p = pipe(surface, force, pt[1], pt[2])
		if not (p and p.valid) then
			return { ok = false, detail = "fuel-pipe create failed at " .. pt[1] .. "," .. pt[2] }
		end
		pipes[#pipes + 1] = p
	end
	local inserted = a.insert_fluid({ name = "thruster-fuel", amount = 500 })
	local id_a = seg_id(a, 1)
	local id_b = seg_id(b, 1)
	local shared = id_a ~= nil and id_a == id_b
	for _, p in ipairs(pipes) do
		if seg_id(p, 1) ~= id_a then shared = false end
	end
	local segment = seg_amount(a, 1)
	return {
		ok = shared and segment == 500,
		detail = string.format("shared_segment=%s(across A.b1+B.b1+11 pipes) seg_id=%s segment=%s(want 500, ==) inserted=%s",
			tostring(shared), tostring(id_a), tostring(segment), tostring(inserted)),
	}
end

-- (c) Fusion-reactor coolant box1 + 3 west pipes share ONE segment; insert 300 into the reactor and
-- EVERY member reads 300 exact. Measured 2.1.11 (coolant box1 ports at rows -1.5/+1.5 west/east).
local function exp_reactor_coolant(reactor, west_pipes)
	if not (reactor and reactor.valid) then return { ok = false, detail = "fusion-reactor missing" } end
	if #west_pipes < 3 then return { ok = false, detail = "west coolant pipes missing (" .. #west_pipes .. "/3)" } end
	local inserted = reactor.insert_fluid({ name = "fluoroketone-cold", amount = 300 })
	local id = seg_id(reactor, 1)
	local shared = id ~= nil
	for _, p in ipairs(west_pipes) do
		if seg_id(p, 1) ~= id then shared = false end
	end
	local all_300 = seg_amount(reactor, 1) == 300
	for _, p in ipairs(west_pipes) do
		if seg_amount(p, 1) ~= 300 then all_300 = false end
	end
	return {
		ok = shared and all_300,
		detail = string.format("shared_segment=%s all_members_300=%s reactor_segment=%s(want 300) inserted=%s",
			tostring(shared), tostring(all_300), tostring(seg_amount(reactor, 1)), tostring(inserted)),
	}
end

-- (d) Inject 150 more via a pipe member; the segment total is 450 EXACT the same instant (capacity
-- shares redistribute but the total is exact at every instant). Measured 2.1.11 (300 -> 450).
local function exp_mixed_injection(reactor, west_pipes)
	if not (reactor and reactor.valid and west_pipes[1]) then
		return { ok = false, detail = "reactor/pipes missing" }
	end
	local inserted = west_pipes[1].insert_fluid({ name = "fluoroketone-cold", amount = 150 })
	local segment = seg_amount(reactor, 1)
	return {
		ok = segment == 450,
		detail = string.format("segment=%s(want 450, == immediately) inserted_via_pipe=%s", tostring(segment), tostring(inserted)),
	}
end

-- (e) Plasma writes clamp to fluidbox capacity. Reactor plasma box2 set to 50 accepts 10; a
-- standalone fusion-generator plasma box1 is segmentless and also clamps a 25 write to 10.
-- Measured 2.1.11 (plasma box2 ports on columns 8.5/11.5 north/south).
local function exp_plasma_clamp(reactor, generator)
	if not (reactor and reactor.valid) then return { ok = false, detail = "reactor missing" } end
	local reactor_set = reactor.set_fluid(2, { name = "fusion-plasma", amount = 50, temperature = 1000000 })
	local reactor_got = reactor.get_fluid(2)
	local reactor_amt = reactor_got and reactor_got.amount or nil
	local ok_reactor = reactor_set == 10 and reactor_amt == 10

	local gen_segment, gen_set
	local ok_gen = false
	if generator and generator.valid then
		gen_segment = generator.has_fluid_segment(1)
		gen_set = generator.set_fluid(1, { name = "fusion-plasma", amount = 25, temperature = 1000000 })
		ok_gen = gen_segment == false and gen_set == 10
	end
	return {
		ok = ok_reactor and ok_gen,
		detail = string.format("reactor set_fluid=%s get=%s(want 10) generator has_segment=%s(want false) set_fluid=%s(want 10)",
			tostring(reactor_set), tostring(reactor_amt), tostring(gen_segment), tostring(gen_set)),
	}
end

-- (f) set_fluid_segment_fluid writes the WHOLE segment in one call: overwrite coolant box1 to 400 and
-- read back 400 exact. Measured 2.1.11 (450 -> 400).
local function exp_segment_write(reactor)
	if not (reactor and reactor.valid) then return { ok = false, detail = "reactor missing" } end
	local set_ret = reactor.set_fluid_segment_fluid(1, { name = "fluoroketone-cold", amount = 400, temperature = -150 })
	local got = seg_amount(reactor, 1)
	return {
		ok = set_ret == 400 and got == 400,
		detail = string.format("set_ret=%s(want 400) segment=%s(want 400)", tostring(set_ret), tostring(got)),
	}
end

-- (g) Segment getters THROW on a segmentless box at 2.1 (2.0 returned nil). The fusion-generator's
-- plasma box1 is segmentless: has_fluid_segment(1)==false and get_fluid_segment_id(1) throws.
local function exp_segment_getter_throws(generator)
	if not (generator and generator.valid) then return { ok = false, detail = "generator missing" } end
	local has = generator.has_fluid_segment(1)
	-- intentional probe; failure expected, no log (the throw IS the law under test)
	local probe_ok = pcall(function() return generator.get_fluid_segment_id(1) end)
	return {
		ok = has == false and probe_ok == false,
		detail = string.format("has_segment=%s(want false) get_fluid_segment_id pcall=%s(want false/threw)",
			tostring(has), tostring(probe_ok)),
	}
end

-- (h) Prototype coverage sweep: create one of each on Nauvis, assert the exact per-box shape
-- (fluids_count, production_type, has_fluid_segment) measured at 2.1.11, destroy each immediately.
-- A drift on any shape fails the row (the point of a re-cert sweep). big-mining-drill is dynamic:
-- 0 boxes off a fluid-requiring resource. maraxsis-regulator is mod-dependent (skipped unless present).
local function exp_prototype_sweep(force)
	local nauvis = (game.planets and game.planets.nauvis and game.planets.nauvis.surface) or game.surfaces["nauvis"]
	if not nauvis then return { ok = false, detail = "nauvis surface missing" } end
	-- Ensure the sweep strip (x 500..~656, y 0) is generated before placing.
	nauvis.request_to_generate_chunks({ 578, 0 }, 5)
	nauvis.force_generate_chunk_requests()

	-- Each spec: name -> ordered box list of { production_type, has_fluid_segment } measured 2.1.11.
	local specs = {
		{ name = "boiler", boxes = { { "input", true }, { "output", false } } },
		{ name = "steam-engine", boxes = { { "input", true } } },
		{ name = "pump", boxes = { { "none", false } } },
		{ name = "pipe-to-ground", boxes = { { "none", true } } },
		{ name = "chemical-plant", boxes = { { "input", false }, { "input", false }, { "output", false }, { "output", false } } },
		-- 2.1.11 drift caught by this instrument's first live run (2026-07-21): the turret's
		-- documented internal buffer became a second enumerable box (b2: get_fluid_box_prototype
		-- returns nil, no segment). The 2.0.77 sweep measured a single box. "?" = expect a nil
		-- box prototype.
		{ name = "flamethrower-turret", boxes = { { "none", true }, { "nil", false } } },
		{ name = "big-mining-drill", boxes = {} },
		{ name = "offshore-pump", boxes = { { "output", false } } },
		{ name = "one-way-valve", boxes = { { "none", true } } },
		{ name = "overflow-valve", boxes = { { "none", true } } },
		{ name = "top-up-valve", boxes = { { "none", true } } },
	}
	if prototypes.entity["maraxsis-regulator-fluidbox-normal"] then
		specs[#specs + 1] = { name = "maraxsis-regulator-fluidbox-normal", boxes = { { "input", true } } }
	end

	local x = 500
	local checked = 0
	local mismatches = {}
	for _, spec in ipairs(specs) do
		local entity = nauvis.create_entity({ name = spec.name, position = { x, 0 }, force = force })
		x = x + 12
		if not (entity and entity.valid) then
			mismatches[#mismatches + 1] = spec.name .. ": create failed"
		else
			checked = checked + 1
			local n = entity.fluids_count or 0
			if n ~= #spec.boxes then
				mismatches[#mismatches + 1] = string.format("%s: fluids_count=%d want %d", spec.name, n, #spec.boxes)
			else
				for i = 1, n do
					local want = spec.boxes[i]
					local production = box_production_type(entity, i)
					local has = entity.has_fluid_segment(i)
					if production ~= want[1] or has ~= want[2] then
						mismatches[#mismatches + 1] = string.format("%s box%d: production=%s/has_segment=%s want %s/%s",
							spec.name, i, tostring(production), tostring(has), want[1], tostring(want[2]))
					end
				end
			end
			entity.destroy()
		end
	end
	return {
		ok = #mismatches == 0,
		detail = (#mismatches == 0) and (checked .. " prototypes matched the measured shapes") or table.concat(mismatches, "; "),
	}
end

-- Run one experiment row pcall-isolated: an unexpected engine throw becomes a FAIL row (logged) so it
-- cannot hide the later laws. Forces the plain-English name onto whatever the experiment returned.
local function run_row(name, fn)
	local ok, result = pcall(fn)
	if not ok then
		log("[fluid-segment-law-selftest] " .. name .. " threw: " .. tostring(result))
		return { name = name, ok = false, detail = "threw: " .. tostring(result) }
	end
	result.name = name
	if result.ok == nil then result.ok = false end
	return result
end

local function fluid_segment_law_selftest()
	if not (storage.surface_export_config and storage.surface_export_config.debug_mode) then
		return { ok = false, err = "debug_mode off" }
	end

	sweep_prior_leftovers()

	local force = game.forces.player
	local platform = force.create_space_platform({
		name = SCRATCH_NAME,
		planet = "nauvis",
		starter_pack = "space-platform-starter-pack",
	})
	if not platform then
		return { ok = false, err = "create_space_platform failed", rows = {}, teardown_clean = true }
	end
	platform.apply_starter_pack()
	platform.paused = true
	local surface = platform.surface
	if not surface then
		return { ok = false, err = "no surface after apply_starter_pack", rows = {}, teardown_clean = false }
	end

	-- Foundation x/y -24..24.
	local tiles = {}
	for x = -24, 24 do
		for y = -24, 24 do
			tiles[#tiles + 1] = { name = "space-platform-foundation", position = { x, y } }
		end
	end
	surface.set_tiles(tiles, true, false, true, false)

	local rows = {}
	rows[#rows + 1] = run_row("pipe and tank control", function() return exp_pipe_and_tank_control(surface, force) end)
	rows[#rows + 1] = run_row("thruster pair shared segment", function() return exp_thruster_pair(surface, force) end)

	-- Shared reactor/generator setup for (c)-(g): reactor at (10,0) 6x6, 3 west coolant pipes,
	-- standalone generator at (-14,0).
	local reactor = surface.create_entity({ name = "fusion-reactor", position = { 10, 0 }, force = force })
	local west_pipes = {}
	if reactor and reactor.valid then
		for _, pt in ipairs({ { 6.5, -1.5 }, { 5.5, -1.5 }, { 4.5, -1.5 } }) do
			local p = pipe(surface, force, pt[1], pt[2])
			if p and p.valid then west_pipes[#west_pipes + 1] = p end
		end
	end
	local generator = surface.create_entity({ name = "fusion-generator", position = { -14, 0 }, force = force })

	rows[#rows + 1] = run_row("fusion reactor coolant", function() return exp_reactor_coolant(reactor, west_pipes) end)
	rows[#rows + 1] = run_row("mixed injection stays exact", function() return exp_mixed_injection(reactor, west_pipes) end)
	rows[#rows + 1] = run_row("plasma write clamps to capacity", function() return exp_plasma_clamp(reactor, generator) end)
	rows[#rows + 1] = run_row("segment write primitive", function() return exp_segment_write(reactor) end)
	rows[#rows + 1] = run_row("segment getters throw on segmentless", function() return exp_segment_getter_throws(generator) end)
	rows[#rows + 1] = run_row("prototype coverage sweep", function() return exp_prototype_sweep(force) end)

	-- GUARANTEED teardown via the HELD reference (never a re-find-by-name: a name match could hit a
	-- prior-run leftover whose deferred deletion is still pending, double-deleting a marked surface).
	local teardown_ok, teardown_err = pcall(function()
		if platform.valid and platform.surface and platform.surface.valid then
			game.delete_surface(platform.surface)
		end
	end)
	if not teardown_ok then
		log("[fluid-segment-law-selftest] teardown error: " .. tostring(teardown_err))
	end

	local all_ok = true
	local pass_n, fail_n = 0, 0
	for _, row in ipairs(rows) do
		if row.ok then pass_n = pass_n + 1 else all_ok = false; fail_n = fail_n + 1 end
	end

	local summary = string.format(
		"[fluid-segment-law-selftest] ok=%s pass=%d fail=%d teardown_clean=%s",
		tostring(all_ok), pass_n, fail_n, tostring(teardown_ok == true))
	game.print(summary)
	if rcon then rcon.print(summary) end

	return { ok = all_ok, rows = rows, teardown_clean = teardown_ok == true }
end

return fluid_segment_law_selftest
