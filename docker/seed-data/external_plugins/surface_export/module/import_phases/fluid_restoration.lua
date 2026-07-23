-- FactorioSurfaceExport - Fluid Restoration (Factorio 2.1 fluid API, fluid-segment registry)
--
-- Consumes the payload's fluid-segment registry: `fluid_segments` (one record per source segment
-- or segmentless storage, keyed by OUR id) plus per-entity `specific_data.fluidboxes` membership
-- ({box_index, segment_ref, local_amount}). Engine segment ids differ across instances, so the
-- destination groups members by RE-DERIVED dest segment id and writes each group once.
--
-- 2.1 write primitives [empirical, 2.1.11, fluid-law experiments 2026-07-21, NOTEBOOK + api-notes fluid section]:
--   * set_fluid_segment_fluid(i, fluid) writes the WHOLE segment in one call (wrote 400 coolant,
--     read back exact) — no more highest-capacity-member workaround.
--   * set_fluid(i, fluid) writes a segmentless storage; returns the accepted amount (capacity
--     clamp measured: plasma 50 -> 10).
--   * Segment getters/setters THROW on segmentless boxes — has_fluid_segment(i) guards every use.
--
-- Failure semantics (owner ruling 2026-07-20, "failure is not an option — fail => revert"):
-- members whose entity failed to place are simply absent; no expected-count adjustment is made
-- for them. A short segment fails the exact gate and the two-phase commit preserves the source.
-- Only physically-measured shortfalls are classified: capacity overflow -> dropped_fluids (a gate
-- failure by design), engine-rejected writes -> write_rejected (subtracted from expected, the one
-- lawful subtraction).

local FluidRestoration = {}

--- Restore fluids from the payload registry.
--- @param entities_to_create table: entity data records (with specific_data.fluidboxes)
--- @param entity_map table: entity_id -> LuaEntity
--- @param fluid_segments table: the payload's fluid_segments array (our-id keyed records)
--- @return table: { count, segments, isolated, segment_temps, write_rejected, dropped_fluids }
function FluidRestoration.restore(entities_to_create, entity_map, fluid_segments)
	log("[Import] Restoring fluids from the segment registry (2.1 segment writes)...")

	-- Index payload segments by our id.
	local by_id = {}
	for _, rec in ipairs(fluid_segments or {}) do
		by_id[rec.id] = rec
	end

	-- Collect surviving members per payload segment ref.
	local members = {}  -- ref -> array of {entity, box_index, local_amount}
	for _, entity_data in ipairs(entities_to_create) do
		local sd = entity_data.specific_data
		local boxes = sd and sd.fluidboxes
		if boxes then
			local entity = entity_map[entity_data.entity_id]
				or entity_map[tostring(entity_data.entity_id)]  -- JSON numeric-key coercion (PR #29)
			if entity and entity.valid then
				for _, box in ipairs(boxes) do
					local ref = box.segment_ref
					if by_id[ref] then
						members[ref] = members[ref] or {}
						table.insert(members[ref], {
							entity = entity,
							box_index = box.box_index,
							local_amount = box.local_amount or 0,
						})
					else
						log(string.format("[Fluid Restore] WARNING: %s box %d references unknown segment %s",
							entity.name, box.box_index or -1, tostring(ref)))
					end
				end
			end
		end
	end

	local dropped_fluids = {}
	local write_rejected = {}
	local segment_temps = {}
	local segment_writes = 0
	local storage_writes = 0
	local dropped_count = 0

	-- One write per (payload segment × dest segment group). Verify by re-read; retry the
	-- remainder with insert_fluid; classify what still refuses.
	local function write_segment_group(rec, group, share)
		local anchor = group[1]
		local cap_ok, cap = pcall(function()
			return anchor.entity.get_fluid_segment_capacity(anchor.box_index)
		end)
		if not cap_ok or not cap then
			log(string.format("[Fluid Restore] Seg cap read failed on %s box %d: %s",
				anchor.entity.name, anchor.box_index, tostring(cap)))
			cap = share
		end
		local final = math.min(share, cap)
		if share > cap + 0.01 then
			local diff = share - cap
			dropped_fluids[rec.fluid] = (dropped_fluids[rec.fluid] or 0) + diff
			dropped_count = dropped_count + 1
			log(string.format("[Fluid Restore Warning] %s: capacity overflow %.2f > %.2f (lost %.2f)",
				rec.fluid, share, cap, diff))
		end
		local temperature = rec.temperature or 15
		local ok, err = pcall(function()
			anchor.entity.set_fluid_segment_fluid(anchor.box_index, {
				name = rec.fluid, amount = final, temperature = temperature,
			})
		end)
		if not ok then
			log(string.format("[Fluid Restore Error] segment write (%s=%.2f) on %s: %s",
				rec.fluid, final, anchor.entity.name, tostring(err)))
		end
		-- Verify what the segment actually holds now.
		local read_ok, seg_fluid = pcall(function()
			return anchor.entity.get_fluid_segment_fluid(anchor.box_index)
		end)
		if not read_ok then
			log(string.format("[Fluid Restore] segment verify read failed on %s box %d: %s",
				anchor.entity.name, anchor.box_index, tostring(seg_fluid)))
		end
		local actual = (read_ok and seg_fluid and seg_fluid.name == rec.fluid) and seg_fluid.amount or 0
		if actual < final - 0.5 then
			local shortfall = final - actual
			local retry_ok, retry_inserted = pcall(function()
				return anchor.entity.insert_fluid({
					name = rec.fluid, amount = shortfall, temperature = temperature,
				})
			end)
			local recovered = (retry_ok and retry_inserted) or 0
			if recovered > 0.5 then
				log(string.format("[Fluid Restore] %s: segment write short on %s, insert_fluid recovered %.2f/%.2f",
					rec.fluid, anchor.entity.name, recovered, shortfall))
			end
			if not retry_ok then
				log(string.format("[Fluid Restore] insert_fluid ERROR on %s: %s",
					anchor.entity.name, tostring(retry_inserted)))
			end
			local still_short = shortfall - recovered
			if still_short > 0.5 then
				log(string.format("[Fluid Restore] %s: engine rejected %.2f on %s (unrestorable)",
					rec.fluid, still_short, anchor.entity.name))
				write_rejected[rec.fluid] = (write_rejected[rec.fluid] or 0) + still_short
			end
		end
		segment_writes = segment_writes + 1
		local seg_id_ok, dest_seg_id = pcall(function()
			return anchor.entity.get_fluid_segment_id(anchor.box_index)
		end)
		if not seg_id_ok then
			log(string.format("[Fluid Restore] dest segment id read failed on %s box %d: %s",
				anchor.entity.name, anchor.box_index, tostring(dest_seg_id)))
		elseif dest_seg_id then
			segment_temps[dest_seg_id] = { fluid = rec.fluid, temp = temperature }
		end
	end

	-- Write a segmentless storage box.
	local function write_storage(rec, member, amount)
		local temperature = rec.temperature or 15
		local ok, accepted = pcall(function()
			return member.entity.set_fluid(member.box_index, {
				name = rec.fluid, amount = amount, temperature = temperature,
			})
		end)
		if not ok then
			log(string.format("[Fluid Restore Error] storage write (%s=%.2f) on %s box %d: %s",
				rec.fluid, amount, member.entity.name, member.box_index, tostring(accepted)))
			accepted = 0
		end
		accepted = accepted or 0
		if accepted < amount - 0.1 then
			local shortfall = amount - accepted
			local retry_ok, retry_inserted = pcall(function()
				return member.entity.insert_fluid({
					name = rec.fluid, amount = shortfall, temperature = temperature,
				})
			end)
			local recovered = (retry_ok and retry_inserted) or 0
			if not retry_ok then
				log(string.format("[Fluid Restore] insert_fluid ERROR on %s: %s",
					member.entity.name, tostring(retry_inserted)))
			end
			local still_short = shortfall - recovered
			if still_short > 0.1 then
				-- Storage boxes have a hard per-box capacity; a shortfall here is a capacity drop
				-- unless the engine refused outright (both classify against the gate honestly).
				log(string.format("[Fluid Restore Warning] storage %s on %s: wanted %.2f, seated %.2f",
					rec.fluid, member.entity.name, amount, amount - still_short))
				dropped_fluids[rec.fluid] = (dropped_fluids[rec.fluid] or 0) + still_short
				dropped_count = dropped_count + 1
			end
		end
		storage_writes = storage_writes + 1
	end

	for ref, rec in pairs(by_id) do
		local group = members[ref]
		if rec.fluid and (rec.total or 0) > 0 and group and #group > 0 then
			-- Partition surviving members by DEST reality: segment-bearing groups vs segmentless.
			local dest_groups = {}   -- dest seg id -> { members..., sum_local }
			local segmentless = {}
			for _, m in ipairs(group) do
				local has_ok, has_seg = pcall(function()
					return m.entity.has_fluid_segment(m.box_index)
				end)
				if not has_ok then
					log(string.format("[Fluid Restore] has_fluid_segment probe failed on %s box %d: %s — treating as segmentless",
						m.entity.name, m.box_index, tostring(has_seg)))
				end
				if has_ok and has_seg then
					local id_ok, dest_id = pcall(function()
						return m.entity.get_fluid_segment_id(m.box_index)
					end)
					if not id_ok then
						log(string.format("[Fluid Restore] segment id read failed on %s box %d: %s",
							m.entity.name, m.box_index, tostring(dest_id)))
					end
					if id_ok and dest_id then
						local g = dest_groups[dest_id]
						if not g then
							g = { sum_local = 0 }
							dest_groups[dest_id] = g
						end
						g[#g + 1] = m
						g.sum_local = g.sum_local + (m.local_amount or 0)
					end
				else
					segmentless[#segmentless + 1] = m
				end
			end

			-- ONE conserving split across EVERY surviving destination unit — dest segment groups
			-- AND segmentless stragglers alike — weighted by captured member locals, so the sum
			-- of writes is exactly rec.total in every topology. (di-change review 2026-07-21,
			-- SHOULD-FIX: the earlier shape wrote the FULL total into the segment groups and then
			-- ADDED straggler locals on top — a mixed segment/segmentless dest topology over-filled
			-- and false-failed the gate as a GAIN. Fails safe, but red on a legitimate transfer.)
			-- A failed bridging entity can split one source segment into several dest segments;
			-- per-member locals are what make a faithful proportional split possible. The pure
			-- storage record (source segmentless, one member) falls out as the single-unit case.
			local units = {}
			local total_weight = 0
			for _, g in pairs(dest_groups) do
				units[#units + 1] = { group = g, weight = g.sum_local }
				total_weight = total_weight + g.sum_local
			end
			for _, m in ipairs(segmentless) do
				units[#units + 1] = { member = m, weight = m.local_amount or 0 }
				total_weight = total_weight + (m.local_amount or 0)
				if rec.source_segment_id then
					log(string.format("[Fluid Restore] WARNING: %s box %d segmentless on dest for source segment %s — included in the conserving split",
						m.entity.name, m.box_index, tostring(rec.source_segment_id)))
				end
			end

			for _, unit in ipairs(units) do
				local share
				if #units == 1 then
					share = rec.total
				elseif total_weight > 0 then
					share = rec.total * (unit.weight / total_weight)
				else
					share = rec.total / #units
				end
				if unit.group then
					write_segment_group(rec, unit.group, share)
				elseif share > 0 then
					write_storage(rec, unit.member, share)
				end
			end
		end
	end

	if dropped_count > 0 then
		local msg = "[Fluid Restore Warning] Capacity limits reached! Dropped amounts: "
		for name, amount in pairs(dropped_fluids) do
			msg = msg .. string.format("%s=%.1f ", name, amount)
		end
		log(msg)
		game.print(msg, { 1, 0.5, 0 })
	end

	log(string.format("[Import] Fluid restoration complete: %d segment writes, %d storage writes.",
		segment_writes, storage_writes))

	return {
		count = segment_writes + storage_writes,
		segments = segment_writes,
		isolated = storage_writes,
		segment_temps = segment_temps,
		write_rejected = write_rejected,
		dropped_fluids = dropped_fluids,
	}
end

return FluidRestoration
