local BlueprintDiff = require("modules/surface_export/export_scanners/blueprint-diff")

local function blueprint_diff_selftest()
	local details = {}
	local passed, failed = 0, 0

	local function check(name, cond, msg)
		if cond then
			passed = passed + 1
			details[#details + 1] = { name = name, ok = true }
		else
			failed = failed + 1
			details[#details + 1] = { name = name, ok = false, msg = msg or "assertion failed" }
		end
	end

	local function properties(findings)
		local names = {}
		for _, finding in ipairs(findings) do names[finding.property] = true end
		return names
	end

	local uncovered = BlueprintDiff.findings_for(
		{ name = "steel-chest", some_unmapped_field = true },
		{ entity_id = 1 }, "container", { x = 0, y = 0 }, 1)
	check("reports_a_field_the_payload_lacks", #uncovered == 1 and uncovered[1].property == "some_unmapped_field",
		"a blueprint field with no payload counterpart must produce exactly one finding, got " .. #uncovered)

	local same_name = BlueprintDiff.findings_for(
		{ name = "assembling-machine-2", recipe = "iron-gear-wheel" },
		{ entity_id = 2, specific_data = { recipe = "iron-gear-wheel" } }, "assembling-machine", { x = 0, y = 0 }, 2)
	check("same_named_key_counts_as_covered", #same_name == 0,
		"recipe present in specific_data must not be reported, got " .. #same_name)

	local aliased = BlueprintDiff.findings_for(
		{ name = "infinity-pipe", infinity_settings = { name = "water" } },
		{ entity_id = 3, infinity_pipe_filter = { name = "water" } }, "infinity-pipe", { x = 0, y = 0 }, 3)
	check("global_alias_counts_as_covered", #aliased == 0,
		"infinity_settings must resolve through the infinity_pipe_filter alias, got " .. #aliased)

	local panel_data = { entity_id = 4, specific_data = { display_panel_messages = { {} } } }
	local panel = BlueprintDiff.findings_for(
		{ name = "display-panel", control_behavior = { parameters = {} } },
		panel_data, "display-panel", { x = 0, y = 0 }, 4)
	check("type_scoped_alias_counts_as_covered", #panel == 0,
		"display-panel control_behavior must resolve to display_panel_messages, got " .. #panel)

	local combinator = BlueprintDiff.findings_for(
		{ name = "arithmetic-combinator", control_behavior = { arithmetic_conditions = {} } },
		{ entity_id = 5 }, "arithmetic-combinator", { x = 0, y = 0 }, 5)
	check("type_scoped_alias_does_not_leak_to_other_types", properties(combinator).control_behavior == true,
		"a combinator missing control_behavior must still be reported — the display-panel alias must not apply")

	local belt_covered = BlueprintDiff.findings_for(
		{ name = "underground-belt", type = "output" },
		{ entity_id = 20, type = "underground-belt", specific_data = { belt_to_ground_type = "output" } },
		"underground-belt", { x = 0, y = 0 }, 20)
	check("type_scoped_alias_reads_the_real_key_not_the_colliding_one", #belt_covered == 0,
		"BeltConnectionType must resolve to belt_to_ground_type, got " .. #belt_covered)

	local belt_missing = BlueprintDiff.findings_for(
		{ name = "underground-belt", type = "output" },
		{ entity_id = 21, type = "underground-belt" },
		"underground-belt", { x = 0, y = 0 }, 21)
	check("colliding_entity_type_key_does_not_satisfy_BeltConnectionType",
		properties(belt_missing).type == true,
		"entity_data.type holds the ENTITY type ('underground-belt'), not the blueprint's "
		.. "BeltConnectionType ('output') — a payload without belt_to_ground_type must still be reported")

	local loader = BlueprintDiff.findings_for(
		{ name = "turbo-loader", type = "output" },
		{ entity_id = 22, type = "loader", specific_data = {} }, "loader", { x = 0, y = 0 }, 22)
	check("alias_only_field_is_never_satisfied_by_its_own_name",
		properties(loader).type == true,
		"a loader has no type-scoped alias and we do not capture loader_type, so BeltConnectionType "
		.. "must be REPORTED — entity_data.type ('loader') must not silently satisfy it")

	local loader_covered = BlueprintDiff.findings_for(
		{ name = "turbo-loader", type = "output" },
		{ entity_id = 23, type = "loader", specific_data = { loader_type = "output" } },
		"loader", { x = 0, y = 0 }, 23)
	check("loader_BeltConnectionType_resolves_to_the_captured_loader_type", #loader_covered == 0,
		"a loader carrying loader_type must be covered — without the capture this field is lost on every "
		.. "transfer and every loader arrives at the create-time default, got " .. #loader_covered)

	local loader1x1_covered = BlueprintDiff.findings_for(
		{ name = "loader-1x1", type = "input" },
		{ entity_id = 24, type = "loader-1x1", specific_data = { loader_type = "input" } },
		"loader-1x1", { x = 0, y = 0 }, 24)
	check("loader_1x1_is_aliased_too_not_just_loader", #loader1x1_covered == 0,
		"loader-1x1 is a separate entity type with the same field — registering only 'loader' would leave "
		.. "every loader-1x1 reported forever, got " .. #loader1x1_covered)

	local ghost_loader = BlueprintDiff.findings_for(
		{ name = "turbo-loader", type = "input" },
		{ entity_id = 25, type = "entity-ghost", specific_data = { ghost_name = "turbo-loader", loader_type = "input" } },
		"entity-ghost", { x = 0, y = 0 }, 25)
	check("ghost_loader_direction_is_seen_through_the_ghost_wrapper", #ghost_loader == 0,
		"the blueprint names a ghost by its INNER entity, but world.type is entity-ghost — without an alias "
		.. "on entity-ghost a correctly captured ghost loader is reported forever, got " .. #ghost_loader)

	local ghost_underground = BlueprintDiff.findings_for(
		{ name = "underground-belt", type = "output" },
		{ entity_id = 26, type = "entity-ghost", specific_data = { ghost_name = "underground-belt" } },
		"entity-ghost", { x = 0, y = 0 }, 26)
	check("ghost_underground_belt_direction_is_still_reported",
		properties(ghost_underground).type == true,
		"we capture loader_type for loader ghosts only — a ghost underground-belt's direction is NOT "
		.. "captured, and the entity-ghost alias must not paper over that")

	local structural = BlueprintDiff.findings_for(
		{ name = "steel-chest", position = { x = 1, y = 1 }, direction = 2, entity_number = 7 },
		{ entity_id = 6 }, "container", { x = 0, y = 0 }, 6)
	check("structural_fields_are_never_findings", #structural == 0,
		"name/position/direction/entity_number are carried outside specific_data, got " .. #structural)

	local defaulted = BlueprintDiff.findings_for(
		{ name = "assembling-machine-2", recipe_quality = "normal" },
		{ entity_id = 7 }, "assembling-machine", { x = 0, y = 0 }, 7)
	check("default_values_are_not_findings", #defaulted == 0,
		"recipe_quality=normal is the default and is stored only when it differs, got " .. #defaulted)

	local schedule = BlueprintDiff.findings_for(
		{ name = "space-platform-hub", schedule = { records = {} } },
		{ entity_id = 8 }, "space-platform-hub", { x = 0, y = 0 }, 8)
	check("platform_level_fields_are_not_entity_findings", #schedule == 0,
		"schedule is captured per platform, not per entity, got " .. #schedule)

	local area = BlueprintDiff.bounding_area({
		[1] = { position = { x = -10, y = 5 } },
		[2] = { position = { x = 20, y = -3 } },
	})
	check("bounding_area_wraps_the_entities", area ~= nil
		and area[1][1] == -10 - BlueprintDiff.AREA_PADDING
		and area[1][2] == -3 - BlueprintDiff.AREA_PADDING
		and area[2][1] == 20 + BlueprintDiff.AREA_PADDING
		and area[2][2] == 5 + BlueprintDiff.AREA_PADDING,
		"the area must be the padded entity bounding box, not a fixed span")

	check("bounding_area_refuses_with_no_positions", BlueprintDiff.bounding_area({}) == nil,
		"no positioned entities must yield nil so the caller reports UNAVAILABLE rather than scanning the world")

	return { passed = passed, failed = failed, total = passed + failed, details = details }
end

return blueprint_diff_selftest
