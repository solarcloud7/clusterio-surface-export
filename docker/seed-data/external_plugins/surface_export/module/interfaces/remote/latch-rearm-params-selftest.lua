local LatchRearm = require("modules/surface_export/import_phases/latch_rearm")

local function latch_rearm_params_selftest()
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

	local function make_item()
		return {
			captured_outputs = { { signal = { type = "virtual", name = "signal-S" }, count = 1 } },
			captured_parameters = {
				conditions = {
					{ first_signal = { type = "virtual", name = "signal-A" }, comparator = ">", constant = 0 },
					{ first_signal = { type = "virtual", name = "signal-S" }, comparator = ">", constant = 0,
						compare_type = "or" },
				},
				outputs = { { signal = { type = "virtual", name = "signal-S" }, copy_count_from_input = false } },
				else_outputs = { { signal = { type = "virtual", name = "signal-R" }, copy_count_from_input = false } },
				future_field = "must-survive",
			},
		}
	end

	local item = make_item()
	local forced = LatchRearm.forced_parameters(item)
	check("forced_preserves_outputs", forced.outputs == item.captured_parameters.outputs,
		"forced_parameters must carry the captured outputs through untouched")
	check("forced_preserves_else_outputs", forced.else_outputs == item.captured_parameters.else_outputs,
		"a rebuilt table drops else_outputs — the E-rung measured the getter emits it at 2.1.11")
	check("forced_preserves_unknown_future_fields", forced.future_field == "must-survive",
		"shallow-copy semantics must carry fields this code has never heard of")
	check("forced_overrides_to_one_always_true_condition",
		#forced.conditions == 1 and forced.conditions[1].comparator == ">="
			and forced.conditions[1].constant == -2147483648
			and forced.conditions[1].first_signal.name == "signal-S",
		"the force stage exists only to make the output fire unconditionally")
	check("forced_does_not_mutate_the_captured_table",
		#item.captured_parameters.conditions == 2
			and item.captured_parameters.conditions[1].comparator == ">",
		"restore writes captured_parameters back verbatim — mutating it corrupts the restore")

	local item2 = make_item()
	local clearing = LatchRearm.clearing_parameters(item2)
	check("clearing_has_one_always_false_condition",
		#clearing.conditions == 1 and clearing.conditions[1].comparator == "<"
			and clearing.conditions[1].constant == -2147483648,
		"the clear window exists only to hold the output at nothing")
	check("clearing_strips_else_outputs_even_when_captured_carries_one",
		clearing.else_outputs == nil,
		"under an always-false condition a preserved else_outputs would FIRE for the whole clear window")
	check("clearing_preserves_outputs", clearing.outputs == item2.captured_parameters.outputs,
		"the cleared latch must keep its own output shape for the restore that follows")
	check("clearing_does_not_mutate_the_captured_table",
		item2.captured_parameters.else_outputs ~= nil
			and #item2.captured_parameters.conditions == 2,
		"clear_restore writes captured_parameters back verbatim — mutating it corrupts the restore")

	return { passed = passed, failed = failed, total = passed + failed, details = details }
end

return latch_rearm_params_selftest
