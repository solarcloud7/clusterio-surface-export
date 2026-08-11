local SignalStability = require("modules/surface_export/utils/signal-stability")

local function signal_stability_selftest()
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

	local S = function(t) return t end
	local stable = { S{ a = 1 }, S{ a = 1 }, S{ a = 1 }, S{ a = 1 }, S{ a = 1 } }
	check("five_equal_snapshots_classify_stable_and_license_the_clear",
		SignalStability.classify(stable, 5) == "stable" and SignalStability.should_clear(stable, 5) == true,
		"got " .. SignalStability.classify(stable, 5))

	local moving_count = { S{ a = 1 }, S{ a = 1 }, S{ a = 2 }, S{ a = 2 }, S{ a = 2 } }
	check("any_count_change_classifies_moving_and_refuses_the_clear",
		SignalStability.classify(moving_count, 5) == "moving"
			and SignalStability.should_clear(moving_count, 5) == false,
		"got " .. SignalStability.classify(moving_count, 5))

	local key_appears = { S{ a = 1 }, S{ a = 1 }, S{ a = 1, b = 1 }, S{ a = 1, b = 1 }, S{ a = 1, b = 1 } }
	check("a_key_appearing_classifies_moving",
		SignalStability.classify(key_appears, 5) == "moving",
		"got " .. SignalStability.classify(key_appears, 5))

	local key_disappears = { S{ a = 1, b = 1 }, S{ a = 1 }, S{ a = 1 }, S{ a = 1 }, S{ a = 1 } }
	check("a_key_disappearing_classifies_moving",
		SignalStability.classify(key_disappears, 5) == "moving",
		"got " .. SignalStability.classify(key_disappears, 5))

	check("quality_distinct_signals_get_distinct_keys",
		SignalStability.signal_key({ type = "virtual", name = "signal-S", quality = "rare" })
			~= SignalStability.signal_key({ type = "virtual", name = "signal-S" }),
		"a rare and a normal signal collapsed to one key — quality mismatches would be invisible")

	local short = { S{ a = 1 }, S{ a = 1 }, S{ a = 1 }, S{ a = 1 } }
	check("insufficient_samples_refuse_the_clear",
		SignalStability.classify(short, 5) == "insufficient"
			and SignalStability.should_clear(short, 5) == false,
		"a destructive write must require positive evidence of stability, got "
			.. SignalStability.classify(short, 5))

	local empties = { S{}, S{}, S{}, S{}, S{} }
	check("five_empty_registers_classify_stable",
		SignalStability.classify(empties, 5) == "stable",
		"got " .. SignalStability.classify(empties, 5))

	check("snapshot_is_nil_safe_and_returns_an_empty_register",
		next(SignalStability.snapshot(nil)) == nil,
		"snapshot(nil) must be {} so a nil signals_last_tick reads as an empty register, not a crash")

	local snap = SignalStability.snapshot({
		{ signal = { type = "virtual", name = "signal-S" }, count = 3 },
		{ signal = { type = "virtual", name = "signal-C", quality = "rare" }, count = 7 },
	})
	check("snapshot_keys_by_the_normalizer_and_keeps_counts",
		snap[SignalStability.signal_key({ type = "virtual", name = "signal-S" })] == 3
			and snap[SignalStability.signal_key({ type = "virtual", name = "signal-C", quality = "rare" })] == 7,
		"snapshot did not key by signal_key or dropped a count")

	check("registers_equal_is_order_independent",
		SignalStability.registers_equal({ a = 1, b = 2 }, { b = 2, a = 1 }) == true
			and SignalStability.registers_equal({ a = 1 }, { a = 1, b = 2 }) == false,
		"equality must compare key sets and counts, nothing else")

	return { passed = passed, failed = failed, total = passed + failed, details = details }
end

return signal_stability_selftest
