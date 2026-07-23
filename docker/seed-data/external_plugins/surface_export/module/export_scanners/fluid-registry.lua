-- FactorioSurfaceExport - Fluid Segment Registry (Factorio 2.1 fluid API)
--
-- THE single fluid-capture discipline. The payload carries two lists:
--   export_data.fluid_segments        one record per fluid segment (or per segmentless storage),
--                                     keyed by OUR incremental id — engine segment ids differ
--                                     across instances, so entities reference OUR id.
--   entity.specific_data.fluidboxes   per-box membership: { box_index, segment_ref, local_amount,
--                                     local_temperature } — locals are the entity's own storage
--                                     (capacity shares on 2.1), kept for census attribution and
--                                     split-segment restore proportioning.
--
-- 2.1 measurement basis [empirical, 2.1.11, fluid-law experiments 2026-07-21, NOTEBOOK + api-notes fluid section]:
--   * get_fluid_segment_fluid(i) returns the EXACT segment total from any member box at any
--     instant (the 2.0 buffer/window duality is gone — thruster 500 and reactor 300→450 read
--     exact from every member, mid-transient and settled).
--   * Segment getters THROW on segmentless boxes (2.0 returned nil) — has_fluid_segment(i) is
--     the mandatory guard. Fusion-generator boxes are segmentless; mining drills off-patch
--     report fluids_count 0.
--   * get_fluid(i) is the entity's own storage read (capacity share of the segment, or the
--     whole content for segmentless boxes).
--
-- Capture is ASYNC-SAFE: one segment read is atomic and total, dedup is by source segment id,
-- and on a frozen source (disabled_by_script) ids and totals are stable across ticks. The
-- re-encounter tripwire below turns mid-scan topology churn into a loud failure instead of a
-- silent double-count; the paired-reads census fails such a transfer closed.

local FluidRegistry = {}

--- New registry. Plain storage-safe data; lives on the export job across the multi-tick walk.
function FluidRegistry.new()
	return {
		segments = {},   -- our id -> segment record
		by_source = {},  -- engine segment id -> our id (dedup across entities AND batches)
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
		measured = source_segment_id and "segment" or "storage",
	}
	registry.segments[rec.id] = rec
	if source_segment_id then
		registry.by_source[source_segment_id] = rec.id
	end
	registry.next_id = registry.next_id + 1
	return rec.id
end

--- Capture one entity's complete fluid state into the registry.
--- Returns the entity-side fluidboxes array, or nil when the entity has no fluid storages.
--- Empty segments/storages are still recorded (tiny records) so every segment_ref stays valid.
--- @param registry table: from FluidRegistry.new()
--- @param entity LuaEntity: valid entity
--- @return table|nil
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
				-- Re-encounter tripwire: the same engine segment must still hold the same fluid.
				-- A mismatch means the network changed mid-scan (merge/split/build) — fail loud;
				-- the census would otherwise see a silent double-count or drop.
				local rec = registry.segments[ref]
				local name = segment_fluid and segment_fluid.name or nil
				if name ~= rec.fluid then
					error(string.format(
						"[FluidRegistry] segment %s changed identity mid-scan (%s -> %s) at %s box %d",
						tostring(source_id), tostring(rec.fluid), tostring(name), entity.name, i))
				end
			end
		else
			-- Segmentless storage (machine buffers, fusion-generator boxes, wagons):
			-- a uniform single-member record keeps ONE shape for every consumer.
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

--- Payload form: dense array of segment records ordered by our id.
function FluidRegistry.list(registry)
	local out = {}
	for id = 1, registry.next_id - 1 do
		out[#out + 1] = registry.segments[id]
	end
	return out
end

--- Sum of totals by fluid name (skips empty records). Shared by verification and the census
--- so expected counts and census-serialized counts can never diverge in how they fold.
--- @param segments table: array (payload form) OR registry.segments map
--- @return table: fluid_name -> total
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
