local FluidRegistry = {}

function FluidRegistry.new()
	return {
		segments = {},
		by_source = {},
		next_id = 1,
	}
end

local function add_record(registry, source_segment_id, fluid)
	local rec = {
		id = registry.next_id,
		source_segment_id = source_segment_id,
		fluid = fluid and fluid.name or nil,
		total = fluid and fluid.amount or 0,
		temperature = fluid and fluid.temperature or nil,
	}
	registry.segments[rec.id] = rec
	if source_segment_id then
		registry.by_source[source_segment_id] = rec.id
	end
	registry.next_id = registry.next_id + 1
	return rec.id
end

function FluidRegistry.capture_entity(registry, entity)
	local count = entity.fluids_count
	if not count or count == 0 then
		return nil
	end

	local boxes = {}
	for i = 1, count do
		local storage = entity.get_fluid(i)
		local ref
		if entity.has_fluid_segment(i) then
			local source_id = entity.get_fluid_segment_id(i)
			ref = registry.by_source[source_id]
			local segment_fluid = entity.get_fluid_segment_fluid(i)
			if not ref then
				ref = add_record(registry, source_id, segment_fluid)
			else
				local rec = registry.segments[ref]
				local name = segment_fluid and segment_fluid.name or nil
				if name ~= rec.fluid then
					error(string.format(
						"[FluidRegistry] segment %s changed identity mid-scan (%s -> %s) at %s box %d",
						tostring(source_id), tostring(rec.fluid), tostring(name), entity.name, i))
				end
			end
		else
			ref = add_record(registry, nil, storage)
		end
		boxes[#boxes + 1] = {
			box_index = i,
			segment_ref = ref,
			local_amount = storage and storage.amount or 0,
			local_temperature = storage and storage.temperature or nil,
		}
	end
	return boxes
end

function FluidRegistry.list(registry)
	local out = {}
	for id = 1, registry.next_id - 1 do
		out[#out + 1] = registry.segments[id]
	end
	return out
end

function FluidRegistry.totals_by_name(segments)
	local totals = {}
	for _, rec in pairs(segments) do
		if rec.fluid and rec.total and rec.total > 0 then
			totals[rec.fluid] = (totals[rec.fluid] or 0) + rec.total
		end
	end
	return totals
end

return FluidRegistry
