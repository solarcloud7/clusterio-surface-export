local Util = require("modules/surface_export/utils/util")

local LossAnalysis = {}

local LOSS_TOLERANCE_PCT = 0.05
local LOSS_TOLERANCE_ABS = 25

function LossAnalysis.reconcile_fluids(expected_counts, actual_counts, high_temp_threshold)
    local HIGH_TEMP = high_temp_threshold or Util.HIGH_TEMP_THRESHOLD

    local expected_ht_by_name = {}
    local actual_ht_by_name = {}
    local expected_ht_energy_by_name = {}
    local actual_ht_energy_by_name = {}
    for key, amt in pairs(expected_counts or {}) do
        local name, temp = Util.parse_fluid_temp_key(key)
        if temp >= HIGH_TEMP then
            expected_ht_by_name[name] = (expected_ht_by_name[name] or 0) + amt
            expected_ht_energy_by_name[name] = (expected_ht_energy_by_name[name] or 0) + (amt * temp)
        end
    end
    for key, amt in pairs(actual_counts or {}) do
        local name, temp = Util.parse_fluid_temp_key(key)
        if temp >= HIGH_TEMP then
            actual_ht_by_name[name] = (actual_ht_by_name[name] or 0) + amt
            actual_ht_energy_by_name[name] = (actual_ht_energy_by_name[name] or 0) + (amt * temp)
        end
    end

    local ht_loss = 0
    local all_ht_names = {}
    for n, _ in pairs(expected_ht_by_name) do all_ht_names[n] = true end
    for n, _ in pairs(actual_ht_by_name) do all_ht_names[n] = true end
    for name, _ in pairs(all_ht_names) do
        local exp = expected_ht_by_name[name] or 0
        local act = actual_ht_by_name[name] or 0
        ht_loss = ht_loss + math.max(0, exp - act)
    end

    local lt_loss = 0
    for key, exp in pairs(expected_counts or {}) do
        local _, temp = Util.parse_fluid_temp_key(key)
        if temp < HIGH_TEMP then
            local act = (actual_counts or {})[key] or 0
            lt_loss = lt_loss + math.max(0, exp - act)
        end
    end

    local total_expected = Util.sum_fluids(expected_counts or {})
    local total_actual = Util.sum_fluids(actual_counts or {})
    local reconciled_loss = lt_loss + ht_loss

    local ht_aggregates = {}
    for name, _ in pairs(all_ht_names) do
        local exp = expected_ht_by_name[name] or 0
        local act = actual_ht_by_name[name] or 0
        local ht_tolerance = math.max(LOSS_TOLERANCE_ABS, exp * LOSS_TOLERANCE_PCT)
        ht_aggregates[name] = {
            expected = exp,
            actual = act,
            delta = act - exp,
            reconciled = math.abs(exp - act) <= ht_tolerance,
            expectedEnergy = expected_ht_energy_by_name[name] or 0,
            actualEnergy = actual_ht_energy_by_name[name] or 0,
        }
    end

    return {
        reconciledLoss = reconciled_loss,
        lowTempLoss = lt_loss,
        highTempReconciledLoss = ht_loss,
        expectedHighTemp = expected_ht_by_name,
        actualHighTemp = actual_ht_by_name,
        allHighTempNames = all_ht_names,
        highTempAggregates = ht_aggregates,
        totalExpected = total_expected,
        totalActual = total_actual,
        rawDelta = total_expected - total_actual,
        fluidPreservedPct = total_expected > 0
            and ((total_expected - reconciled_loss) / total_expected * 100)
            or 100,
        highTempThreshold = HIGH_TEMP,
    }
end

return LossAnalysis
