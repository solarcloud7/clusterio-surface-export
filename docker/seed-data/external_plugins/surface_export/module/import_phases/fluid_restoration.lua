local FluidRestoration = {}

function FluidRestoration.restore(entities_to_create, entity_map, fluid_segments)
	log("[Import] Restoring fluids from the segment registry (2.1 segment writes)...")

	local by_id = {}
	for _, rec in ipairs(fluid_segments or {}) do
		by_id[rec.id] = rec
	end

	local members = {}
	for _, entity_data in ipairs(entities_to_create) do
		local sd = entity_data.specific_data
		local boxes = sd and sd.fluidboxes
		if boxes then
			local entity = entity_map[entity_data.entity_id]
				or entity_map[tostring(entity_data.entity_id)]
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
				log(string.format("[Fluid Restore Warning] storage %s on %s: wanted %.2f, seated %.2f",
					rec.fluid, member.entity.name, amount, amount - still_short))
				dropped_fluids[rec.fluid] = (dropped_fluids[rec.fluid] or 0) + still_short
				dropped_count = dropped_count + 1
			end
		end
		storage_writes = storage_writes + 1
	end

	local pending_segments = {}
	for ref, rec in pairs(by_id) do
		local group = members[ref]
		if rec.fluid and (rec.total or 0) > 0 and group and #group > 0 then
			local dest_groups = {}
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

			local units = {}
			local total_weight = 0
			for dest_id, g in pairs(dest_groups) do
				units[#units + 1] = { group = g, dest_id = dest_id, weight = g.sum_local }
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
				if unit.group and share > 0 then
					local plan = pending_segments[unit.dest_id]
					if not plan then
						plan = { group = unit.group, by_fluid = {} }
						pending_segments[unit.dest_id] = plan
					end
					local acc = plan.by_fluid[rec.fluid]
					if not acc then
						acc = { amount = 0, temp_weighted = 0 }
						plan.by_fluid[rec.fluid] = acc
					end
					acc.amount = acc.amount + share
					acc.temp_weighted = acc.temp_weighted + share * (rec.temperature or 15)
				elseif not unit.group and share > 0 then
					write_storage(rec, unit.member, share)
				end
			end
		end
	end

	for dest_id, plan in pairs(pending_segments) do
		local fluid_names = {}
		for fluid_name in pairs(plan.by_fluid) do fluid_names[#fluid_names + 1] = fluid_name end
		if #fluid_names > 1 then
			table.sort(fluid_names)
			log(string.format(
				"[Fluid Restore] CONFLICT: dest segment %s received records of %d fluids (%s) — nothing written, the gate will refuse",
				tostring(dest_id), #fluid_names, table.concat(fluid_names, ", ")))
		else
			local fluid_name = fluid_names[1]
			local acc = plan.by_fluid[fluid_name]
			write_segment_group({
				fluid = fluid_name,
				temperature = acc.amount > 0 and (acc.temp_weighted / acc.amount) or 15,
			}, plan.group, acc.amount)
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
