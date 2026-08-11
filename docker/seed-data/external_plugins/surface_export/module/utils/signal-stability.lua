local SignalStability = {}

function SignalStability.signal_key(signal)
	return (signal.type or "item") .. "|" .. tostring(signal.name) .. "|" .. (signal.quality or "normal")
end

function SignalStability.snapshot(signals_last_tick)
	local snap = {}
	for _, s in pairs(signals_last_tick or {}) do
		if s.signal and s.signal.name then
			snap[SignalStability.signal_key(s.signal)] = s.count
		end
	end
	return snap
end

function SignalStability.registers_equal(a, b)
	for k, v in pairs(a) do
		if b[k] ~= v then return false end
	end
	for k in pairs(b) do
		if a[k] == nil then return false end
	end
	return true
end

function SignalStability.classify(samples, min_samples)
	if type(samples) ~= "table" or #samples < (min_samples or 2) then
		return "insufficient"
	end
	for i = 2, #samples do
		if not SignalStability.registers_equal(samples[i - 1], samples[i]) then
			return "moving"
		end
	end
	return "stable"
end

function SignalStability.should_clear(samples, min_samples)
	return SignalStability.classify(samples, min_samples) == "stable"
end

return SignalStability
