local SurfaceCounter = require("modules/surface_export/validators/surface-counter")

local PhaseCensus = {}

PhaseCensus.SUBJECT_INVENTORIES = "inventories"
PhaseCensus.SUBJECT_BELTS = "belts"
PhaseCensus.SUBJECT_HELD = "held"
PhaseCensus.SUBJECT_GROUND = "ground"

local function add_into(totals, contribution)
	for key, count in pairs(contribution) do
		totals[key] = (totals[key] or 0) + count
	end
end

local function resolve_entities(scope)
	if scope == nil then return {} end
	if scope.object_name == "LuaSurface" then
		if not scope.valid then return {} end
		return scope.find_entities_filtered({})
	end
	return scope
end

function PhaseCensus.count_subject(scope, subject)
	local totals = {}
	for _, entity in pairs(resolve_entities(scope)) do
		add_into(totals, SurfaceCounter.count_entity_items(entity, subject))
	end
	return totals
end

function PhaseCensus.diff(before, after)
	local delta = {}
	local keys = {}
	for key in pairs(before or {}) do keys[key] = true end
	for key in pairs(after or {}) do keys[key] = true end
	for key in pairs(keys) do
		local d = ((after or {})[key] or 0) - ((before or {})[key] or 0)
		if d ~= 0 then
			delta[key] = d
		end
	end
	return delta
end

function PhaseCensus.open(job, phase, subject, scope)
	if not job or not job.phase_census then return end
	if scope == nil then
		job.phase_census[phase] = { subject = subject, unmeasured = true }
		return
	end
	local counts = PhaseCensus.count_subject(scope, subject)
	job.phase_census[phase] = { subject = subject, before = counts }
end

function PhaseCensus.close(job, phase, subject, scope)
	if not job or not job.phase_census then return {} end
	local record = job.phase_census[phase]
	if not record or record.before == nil or scope == nil then
		job.phase_census[phase] = { subject = subject, unmeasured = true }
		return {}
	end
	local after = PhaseCensus.count_subject(scope, subject)
	local delta = PhaseCensus.diff(record.before, after)
	job.phase_census[phase] = { subject = subject, delta = delta }
	return delta
end

function PhaseCensus.record_external(job, phase, subject, delta, line_set)
	if not job or not job.phase_census then return end
	job.phase_census[phase] = { subject = subject, delta = delta or {}, line_set = line_set }
end

function PhaseCensus.record_baseline(job, phase, scope)
	if not job or not job.phase_census then return end
	if scope == nil then
		job.phase_census[phase] = { subject = "all", unmeasured = true }
		return
	end
	local entities = resolve_entities(scope)
	local counts = PhaseCensus.count_subject(entities, nil)
	add_into(counts, PhaseCensus.count_subject(entities, PhaseCensus.SUBJECT_GROUND))
	job.phase_census[phase] = { subject = "all", delta = counts, baseline = true }
end

function PhaseCensus.total(job)
	local combined = {}
	local complete = true
	for _, record in pairs((job or {}).phase_census or {}) do
		if record.unmeasured then
			complete = false
		else
			add_into(combined, record.delta or {})
		end
	end
	for key, value in pairs(combined) do
		if value == 0 then combined[key] = nil end
	end
	return combined, complete
end

function PhaseCensus.format(job)
	local parts = {}
	for phase, record in pairs((job or {}).phase_census or {}) do
		if record.unmeasured then
			parts[#parts + 1] = phase .. " UNMEASURED"
		else
			local entries = {}
			for key, delta in pairs(record.delta or {}) do
				entries[#entries + 1] = string.format("%s %+d", key, delta)
			end
			table.sort(entries)
			parts[#parts + 1] = phase .. " " .. (#entries > 0 and table.concat(entries, ", ") or "0")
		end
	end
	table.sort(parts)
	return table.concat(parts, " | ")
end

return PhaseCensus
