-- FactorioSurfaceExport - Platform Schedule Utilities
-- Captures and restores full LuaSpacePlatform schedule data (records + interrupts + group)

local Util = require("modules/surface_export/utils/util")

local PlatformSchedule = {}

--- Deep clone a value through JSON to guarantee compatibility with IPC/storage.
--- @param value any
--- @return table|nil, string|nil
local function json_clone(value)
	local encoded, encode_err = Util.encode_json_compat(value)
	if not encoded then
		return nil, "JSON encode failed: " .. tostring(encode_err)
	end

	local decoded, decode_err = Util.json_to_table_compat(encoded)
	if decode_err then
		return nil, "JSON decode failed: " .. tostring(decode_err)
	end

	-- JSON null decodes to nil; callers treat nil as empty payload where appropriate.
	return decoded, nil
end

--- Return a full schedule payload with records + interrupts + group.
--- Uses hub_entity.platform when provided so schedule source matches hub context.
--- @param platform LuaSpacePlatform
--- @param hub_entity LuaEntity|nil
--- @return table|nil, string|nil
function PlatformSchedule.capture(platform, hub_entity)
	local schedule_platform = platform

	if hub_entity and hub_entity.valid then
		local ok_hub_platform, hub_platform = pcall(function()
			return hub_entity.platform
		end)
		if ok_hub_platform and hub_platform and hub_platform.valid then
			schedule_platform = hub_platform
		end
	end

	if not schedule_platform or not schedule_platform.valid then
		return nil, "Schedule source platform is not valid"
	end
	if type(schedule_platform.get_schedule) ~= "function" then
		return nil, "LuaSpacePlatform.get_schedule() is unavailable"
	end

	local ok_schedule, schedule_or_err = pcall(function()
		return schedule_platform.get_schedule()
	end)
	if not ok_schedule then
		return nil, "get_schedule() failed: " .. tostring(schedule_or_err)
	end

	local schedule = schedule_or_err
	if not schedule then
		return {
			current = 1,
			records = {},
			interrupts = {},
			group = nil,
		}, nil
	end

	local ok_records, records_or_err = pcall(function()
		return schedule.get_records()
	end)
	if not ok_records then
		return nil, "get_records() failed: " .. tostring(records_or_err)
	end

	local records_copy, records_err = json_clone(records_or_err or {})
	if records_err then
		return nil, "Failed to clone schedule records: " .. records_err
	end

	local ok_interrupts, interrupts_or_err = pcall(function()
		return schedule.get_interrupts()
	end)
	if not ok_interrupts then
		return nil, "get_interrupts() failed: " .. tostring(interrupts_or_err)
	end

	local interrupts_copy, interrupts_err = json_clone(interrupts_or_err or {})
	if interrupts_err then
		return nil, "Failed to clone schedule interrupts: " .. interrupts_err
	end

	local current = 1
	local ok_current, current_or_err = pcall(function()
		return schedule.current
	end)
	if ok_current and type(current_or_err) == "number" and current_or_err >= 1 then
		current = current_or_err
	end

	local group = nil
	local ok_group, group_or_err = pcall(function()
		return schedule.group
	end)
	if ok_group then
		group = group_or_err
	end

	return {
		current = current,
		records = records_copy or {},
		interrupts = interrupts_copy or {},
		group = group,
	}, nil
end

--- Strict validation for transfer payload cutover.
--- @param schedule_payload table|nil
--- @return boolean, string|nil
function PlatformSchedule.validate_transfer_payload(schedule_payload)
	if type(schedule_payload) ~= "table" then
		return false, "platform.schedule must be a table"
	end
	if type(schedule_payload.records) ~= "table" then
		return false, "platform.schedule.records must be an array table"
	end
	if type(schedule_payload.interrupts) ~= "table" then
		return false, "platform.schedule.interrupts must be an array table"
	end
	if schedule_payload.current ~= nil then
		if type(schedule_payload.current) ~= "number" then
			return false, "platform.schedule.current must be a number when provided"
		end
		if schedule_payload.current < 1 then
			return false, "platform.schedule.current must be >= 1"
		end
	end
	return true, nil
end

--- Apply a full schedule payload to a platform, including interrupts and group.
--- @param platform LuaSpacePlatform
--- @param schedule_payload table
--- @return boolean, string|nil
function PlatformSchedule.apply(platform, schedule_payload)
	if not platform or not platform.valid then
		return false, "Target platform is not valid"
	end
	if type(schedule_payload) ~= "table" then
		return false, "Schedule payload must be a table"
	end
	if type(schedule_payload.records) ~= "table" then
		return false, "Schedule payload missing records array"
	end
	if type(schedule_payload.interrupts) ~= "table" then
		return false, "Schedule payload missing interrupts array"
	end

	local records_copy, records_err = json_clone(schedule_payload.records)
	if records_err then
		return false, "Failed to clone schedule records: " .. records_err
	end
	local interrupts_copy, interrupts_err = json_clone(schedule_payload.interrupts)
	if interrupts_err then
		return false, "Failed to clone schedule interrupts: " .. interrupts_err
	end

	local current = 1
	if type(schedule_payload.current) == "number" and schedule_payload.current >= 1 then
		current = schedule_payload.current
	end

	local base_schedule = {
		current = current,
		records = records_copy or {},
	}
	local ok_set_base, set_base_err = pcall(function()
		platform.schedule = base_schedule
	end)
	if not ok_set_base then
		return false, "Failed to assign base platform.schedule: " .. tostring(set_base_err)
	end

	local ok_schedule, schedule_or_err = pcall(function()
		return platform.get_schedule()
	end)
	if not ok_schedule then
		return false, "get_schedule() after assignment failed: " .. tostring(schedule_or_err)
	end

	local schedule = schedule_or_err
	if not schedule then
		if #(interrupts_copy or {}) == 0 and schedule_payload.group == nil then
			return true, nil
		end
		return false, "LuaSchedule unavailable after assigning platform.schedule"
	end

	if schedule_payload.group ~= nil then
		local ok_group, group_err = pcall(function()
			schedule.group = schedule_payload.group
		end)
		if not ok_group then
			return false, "Failed to set schedule group: " .. tostring(group_err)
		end
	end

	local ok_interrupts, set_interrupts_err = pcall(function()
		schedule.set_interrupts(interrupts_copy or {})
	end)
	if not ok_interrupts then
		return false, "Failed to set schedule interrupts: " .. tostring(set_interrupts_err)
	end

	return true, nil
end

--- Lightweight summary for logs/metrics.
--- @param schedule_payload table|nil
--- @return table
function PlatformSchedule.summarize(schedule_payload)
	local summary = {
		record_count = 0,
		interrupt_count = 0,
		current = nil,
		group = nil,
	}
	if type(schedule_payload) ~= "table" then
		return summary
	end
	if type(schedule_payload.records) == "table" then
		summary.record_count = #schedule_payload.records
	end
	if type(schedule_payload.interrupts) == "table" then
		summary.interrupt_count = #schedule_payload.interrupts
	end
	if type(schedule_payload.current) == "number" then
		summary.current = schedule_payload.current
	end
	if schedule_payload.group ~= nil then
		summary.group = schedule_payload.group
	end
	return summary
end

return PlatformSchedule
