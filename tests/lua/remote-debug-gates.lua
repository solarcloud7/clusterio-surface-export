local root = "docker/seed-data/external_plugins/surface_export/module/"
do
    local top, grants, clears, available = {}, 0, 0, true
    top.add = function(spec)
        local button = {name = spec.name, valid = true}
        button.destroy = function() top[spec.name] = nil end
        top[spec.name] = button
        return button
    end
    local player = {gui = {top = top}, set_shortcut_available = function(_, value) available = value end,
        clear_cursor = function() clears = clears + 1; return false end,
        cursor_stack = {valid = true, set_stack = function() grants = grants + 1 end}}
    local ui_env = setmetatable({storage = {surface_export_config = {debug_mode = false}},
        prototypes = {shortcut = {["selection-lab-tool"] = {}}, item = {["selection-lab-tool"] = {}}},
        game = {get_player = function() return player end}}, {__index = _G})
    local controls = assert(loadfile(root .. "interfaces/gui/debug-controls.lua", "t", ui_env))()
    controls.refresh(player)
    assert(not next(top, "add") and not available)
    ui_env.storage.surface_export_config.debug_mode = true
    controls.refresh(player)
    assert(not top.surfexp_selection_lab, "default debug=true must not expose the lab before configuration arrives")
    ui_env.storage.surface_export_configuration_received = true
    controls.refresh(player)
    local button = assert(top.surfexp_selection_lab)
    controls.on_gui_click{element = button, player_index = 1}
    assert(clears == 1 and grants == 0, "a refused cursor clear must not overwrite possessions")
    player.cursor_stack = nil
    controls.on_gui_click{element = button, player_index = 1}
    assert(clears == 1 and grants == 0, "a spectator without a cursor must not attempt to acquire the tool")
    ui_env.storage.surface_export_config.debug_mode = false
    controls.on_gui_click{element = button, player_index = 1}
    assert(not top.surfexp_selection_lab and grants == 0 and clears == 1, "a late click must respect debug off")
    local parsing = true
    ui_env.game.players = {player}
    ui_env.log = function() end
    ui_env.require = function(name)
        assert(parsing, "Require can't be used outside of control.lua parsing.")
        if name == "modules/surface_export/interfaces/gui/debug-controls" then return controls end
        return {}
    end
    local configure = assert(loadfile(root .. "interfaces/remote/configure.lua", "t", ui_env))()
    parsing = false
    configure{debug_mode = true}
    assert(top.surfexp_selection_lab, "runtime debug enable must refresh the control")
    configure{debug_mode = false}
    assert(not top.surfexp_selection_lab, "runtime debug disable must remove the control")
end
local calls, registered = {}, nil
local env = setmetatable({}, {__index = _G})
env.remote = {add_interface = function(name, api) assert(name == "surface_export"); registered = api end}
local function spy(name)
    return function(...)
        calls[#calls + 1] = {name = name, args = table.pack(...)}
        return "executed", nil, "tail"
    end
end
local table_modules = { ["core/source-recovery"] = true, ["interfaces/remote/test-runner"] = true,
	["interfaces/gui/teleport-gui"] = true,
    ["interfaces/remote/configure-gateways"] = true, ["interfaces/remote/test-roster"] = true,
    ["interfaces/remote/lifecycle"] = true, ["interfaces/remote/upload-session"] = true }
env.require = function(name)
    local key = name:gsub("^modules/surface_export/", "")
    if key == "core/json" then return {encode = function(value) return "json:" .. tostring(value) end} end
    if key == "interfaces/remote/base" then return assert(loadfile(root .. key .. ".lua", "t", env))() end
    if key == "version" then return "fixture-version" end
    if key == "build-id" then return "fixture-build" end
    if table_modules[key] then return setmetatable({}, {__index = function(_, method) return spy(key .. "." .. method) end}) end
    return spy(key)
end
local api = assert(loadfile(root .. "interfaces/remote-interface.lua", "t", env))()
api.register() -- registration must work before storage initialization
assert(registered.get_module_version() == "fixture-version")
assert(registered.get_module_build_id() == "fixture-build")
local test_commands = {
    "test_import_entity", "run_tests", "clone_platform", "version_selftest", "timing_selftest", "selection_lab_drive",
    "belt_side_restore_selftest", "inventory_import_guard_selftest", "gateway_selftest", "schedule_selftest",
    "transfer_lock_selftest", "no_tick_sync_selftest", "fluid_segment_law_selftest", "pole_copper_prune_selftest",
    "hold_aware_unlock_selftest", "export_cache_selftest", "blueprint_diff_selftest", "import_target_selftest",
    "signal_stability_selftest", "latch_rearm_params_selftest", "gateway_config_staging_selftest",
    "set_test_roster", "set_test_roster_begin", "set_test_roster_chunk", "set_test_roster_commit",
    "lifecycle_setup", "lifecycle_dest_setup", "lifecycle_verify", "lifecycle_teardown",
}
for _, mode in ipairs({"missing-storage", "missing-config", "missing-flag", false, "false", 1}) do
    env.storage = nil
    if mode ~= "missing-storage" then env.storage = {} end
    if mode ~= "missing-storage" and mode ~= "missing-config" then
        env.storage.surface_export_config = mode == "missing-flag" and {} or {debug_mode = mode}
    end
    for _, name in ipairs(test_commands) do
        assert(registered[name], "unregistered test entry: " .. name)
        local entry_points = {registered[name]}
        if registered[name .. "_json"] then entry_points[#entry_points + 1] = registered[name .. "_json"] end
        if api[name] then entry_points[#entry_points + 1] = api[name] end
        for _, fn in ipairs(entry_points) do
            local before = #calls
            local ok, err = pcall(fn, 1, nil, 3)
            assert(not ok and tostring(err):find("debug_mode"), name .. " ran with debug disabled: " .. tostring(mode))
            assert(#calls == before, name .. " touched its implementation before refusing")
        end
    end
    assert(registered.get_module_version() == "fixture-version")
    assert(registered.list_platforms() == "executed", "normal operation was debug-gated")
    assert(registered.get_test_roster_summary() == "executed", "read-only roster observation was gated")
    assert(registered.lifecycle_leftovers() == "executed", "cleanup observation was gated")
end
env.storage = {surface_export_config = {debug_mode = true}}
for _, name in ipairs(test_commands) do
    local before = #calls
    local a, b, c = registered[name](1, nil, 3)
    assert(a == "executed" and b == nil and c == "tail", name .. " changed return values")
    assert(#calls == before + 1 and calls[#calls].args.n == 3 and calls[#calls].args[3] == 3)
    if registered[name .. "_json"] then assert(registered[name .. "_json"]() == "json:executed") end
end
env.storage.surface_export_config.debug_mode = false
assert(not pcall(registered.belt_side_restore_selftest), "guard captured stale debug=true at registration")
assert(not pcall(api.test_runner.run_tests), "direct test-runner export bypassed the guard")
print("PASS all test commands and JSON aliases refuse before implementation unless debug_mode is true")
