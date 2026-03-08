-- FactorioSurfaceExport - Transaction Dashboard GUI
-- In-game dashboard displaying transaction history with profiler snapshots.
--
-- CRITICAL: Phase timing uses LocalisedString snapshots stored in transaction_history.
-- These survive save/load because they were captured as {"", profiler_object} arrays
-- at completion time, before PhaseProfiler.discard().

local TransactionHistory = require("modules/surface_export/utils/transaction-history")

local TransactionDashboard = {}

-- Module-local state for open GUIs (not serializable, runtime only)
-- player_index → { frame = LuaGuiElement, limit = number }
local open_dashboards = {}

-- Colors for operation types and status
local OP_COLORS = {
	import = {r = 0.4, g = 0.8, b = 1.0},     -- Light blue
	export = {r = 0.4, g = 1.0, b = 0.4},     -- Light green
	transfer = {r = 1.0, g = 0.8, b = 0.3}    -- Gold
}

local STATUS_COLORS = {
	complete = {r = 0.3, g = 0.9, b = 0.3},   -- Green
	failed = {r = 0.9, g = 0.3, b = 0.3}      -- Red
}

--- Format tick duration as seconds
local function format_duration(ticks)
	if not ticks or ticks == 0 then return "0s" end
	return string.format("%.1fs", ticks / 60)
end

--- Build the transaction table rows
local function build_table_rows(table_elem, limit)
	local entries = TransactionHistory.list(limit)
	
	if #entries == 0 then
		-- Empty state
		local empty_label = table_elem.add{
			type = "label",
			caption = "No transactions recorded yet. Complete an import or export to see history.",
			style = "heading_3_label"
		}
		empty_label.style.column_span = 8
		return
	end
	
	for _, entry in ipairs(entries) do
		-- Row background color based on operation type
		local op_color = OP_COLORS[entry.op_type] or {r = 0.5, g = 0.5, b = 0.5}
		
		-- Seq
		table_elem.add{type = "label", caption = tostring(entry.seq)}
		
		-- Tick
		table_elem.add{type = "label", caption = tostring(entry.tick)}
		
		-- Type (colored)
		local type_label = table_elem.add{type = "label", caption = entry.op_type}
		type_label.style.font_color = op_color
		
		-- Platform
		table_elem.add{type = "label", caption = entry.platform_name or "Unknown"}
		
		-- Entities
		table_elem.add{type = "label", caption = tostring(entry.entity_count or 0)}
		
		-- Duration
		table_elem.add{type = "label", caption = format_duration(entry.duration_ticks)}
		
		-- Status (colored)
		local status_label = table_elem.add{type = "label", caption = entry.status}
		if STATUS_COLORS[entry.status] then
			status_label.style.font_color = STATUS_COLORS[entry.status]
		end
		
		-- Details button
		local details_btn = table_elem.add{
			type = "button",
			caption = "Details",
			name = "transaction_dashboard_details_" .. entry.seq,
			style = "mini_button"
		}
		-- Store entry seq in tags for handler
		details_btn.tags = {transaction_seq = entry.seq}
	end
end

--- Build phase detail flow (for detail popup)
local function build_phase_details(container, entry)
	if not entry.phase_snapshots then
		container.add{type = "label", caption = "No phase timing data available"}
		return
	end
	
	-- Create a table for phase timing
	local phase_table = container.add{
		type = "table",
		column_count = 2,
		name = "phase_timing_table"
	}
	phase_table.style.column_alignments[1] = "right"
	phase_table.style.horizontal_spacing = 12
	
	-- Header
	local header1 = phase_table.add{type = "label", caption = "Phase", style = "heading_3_label"}
	local header2 = phase_table.add{type = "label", caption = "Duration", style = "heading_3_label"}
	
	-- Phase rows
	-- CRITICAL: phase_snapshots values are LocalisedString arrays {"", profiler_object}
	-- These render correctly in GUI labels even after save/load
	for phase_name, snapshot in pairs(entry.phase_snapshots) do
		phase_table.add{type = "label", caption = phase_name}
		-- snapshot is a LocalisedString array - assign it directly to caption
		phase_table.add{type = "label", caption = snapshot}
	end
end

--- Open detail popup for a specific transaction
function TransactionDashboard.open_details(player, seq)
	local entries = TransactionHistory.list(200)  -- Search up to 200
	local entry = nil
	for _, e in ipairs(entries) do
		if e.seq == seq then
			entry = e
			break
		end
	end
	
	if not entry then
		player.print("[Transaction Dashboard] Entry #" .. seq .. " not found")
		return
	end
	
	-- Close existing detail popup if any
	if player.gui.screen["transaction_detail_frame"] then
		player.gui.screen["transaction_detail_frame"].destroy()
	end
	
	-- Create detail popup
	local frame = player.gui.screen.add{
		type = "frame",
		direction = "vertical",
		caption = {"", "Transaction #", seq, " - ", entry.platform_name},
		name = "transaction_detail_frame"
	}
	frame.auto_center = true
	frame.style.maximal_width = 600
	
	-- Metadata flow
	local metadata_flow = frame.add{type = "flow", direction = "vertical"}
	metadata_flow.add{type = "label", caption = {"", "[font=default-bold]Operation:[/font] ", entry.op_type}}
	metadata_flow.add{type = "label", caption = {"", "[font=default-bold]Tick:[/font] ", entry.tick}}
	metadata_flow.add{type = "label", caption = {"", "[font=default-bold]Entities:[/font] ", entry.entity_count}}
	metadata_flow.add{type = "label", caption = {"", "[font=default-bold]Duration:[/font] ", format_duration(entry.duration_ticks)}}
	
	if entry.validation then
		local val_text = entry.validation.success and "✓ Passed" or "✗ Failed"
		if entry.validation.mismatch_summary then
			val_text = val_text .. " - " .. entry.validation.mismatch_summary
		end
		metadata_flow.add{type = "label", caption = {"", "[font=default-bold]Validation:[/font] ", val_text}}
	end
	
	-- Phase timing section
	metadata_flow.add{type = "line"}
	metadata_flow.add{type = "label", caption = "Phase Timing", style = "heading_2_label"}
	build_phase_details(metadata_flow, entry)
	
	-- Close button
	local button_flow = frame.add{type = "flow", direction = "horizontal"}
	button_flow.style.top_margin = 8
	button_flow.add{type = "empty-widget"}.style.horizontally_stretchable = true
	local close_btn = button_flow.add{
		type = "button",
		caption = "Close",
		name = "transaction_detail_close"
	}
	close_btn.style.minimal_width = 100
end

--- Open the main transaction dashboard
function TransactionDashboard.open(player, limit)
	limit = limit or 25
	
	-- Close existing if open
	if player.gui.screen["transaction_dashboard_frame"] then
		player.gui.screen["transaction_dashboard_frame"].destroy()
	end
	
	-- Create main frame
	local frame = player.gui.screen.add{
		type = "frame",
		direction = "vertical",
		caption = "Transaction Dashboard",
		name = "transaction_dashboard_frame"
	}
	frame.auto_center = true
	frame.style.maximal_width = 1000
	frame.style.maximal_height = 800
	
	-- Toolbar
	local toolbar = frame.add{type = "flow", direction = "horizontal"}
	toolbar.style.vertical_align = "center"
	
	toolbar.add{type = "label", caption = "Show:", style = "heading_3_label"}
	
	-- Limit buttons
	for _, l in ipairs({10, 25, 50, 100}) do
		local btn = toolbar.add{
			type = "button",
			caption = tostring(l),
			name = "transaction_dashboard_limit_" .. l,
			style = l == limit and "slot_button" or "tool_button"
		}
		btn.style.width = 40
	end
	
	toolbar.add{type = "empty-widget"}.style.horizontally_stretchable = true
	
	-- Clear history button (admin only)
	local clear_btn = toolbar.add{
		type = "button",
		caption = "Clear History",
		name = "transaction_dashboard_clear",
		style = "red_button"
	}
	clear_btn.enabled = player.admin
	
	-- Scroll pane for table
	local scroll = frame.add{
		type = "scroll-pane",
		direction = "vertical"
	}
	scroll.style.maximal_height = 700
	scroll.style.horizontally_stretchable = true
	
	-- Transaction table
	local table_elem = scroll.add{
		type = "table",
		column_count = 8,
		name = "transaction_table",
		draw_horizontal_lines = true
	}
	table_elem.style.horizontal_spacing = 12
	table_elem.style.vertical_spacing = 4
	
	-- Headers
	table_elem.add{type = "label", caption = "Seq", style = "heading_3_label"}
	table_elem.add{type = "label", caption = "Tick", style = "heading_3_label"}
	table_elem.add{type = "label", caption = "Type", style = "heading_3_label"}
	table_elem.add{type = "label", caption = "Platform", style = "heading_3_label"}
	table_elem.add{type = "label", caption = "Entities", style = "heading_3_label"}
	table_elem.add{type = "label", caption = "Duration", style = "heading_3_label"}
	table_elem.add{type = "label", caption = "Status", style = "heading_3_label"}
	table_elem.add{type = "label", caption = "", style = "heading_3_label"}  -- Details column
	
	-- Build rows
	build_table_rows(table_elem, limit)
	
	-- Status bar
	local status_flow = frame.add{type = "flow", direction = "horizontal"}
	status_flow.style.top_margin = 8
	local count = TransactionHistory.count()
	status_flow.add{type = "label", caption = {"", "Total: ", count, " transactions"}}
	
	-- Track open dashboard
	open_dashboards[player.index] = {
		frame = frame,
		limit = limit
	}
end

--- Close the dashboard for a player
function TransactionDashboard.close(player)
	if player.gui.screen["transaction_dashboard_frame"] then
		player.gui.screen["transaction_dashboard_frame"].destroy()
	end
	open_dashboards[player.index] = nil
end

--- Refresh the dashboard if it's open
function TransactionDashboard.refresh(player)
	local state = open_dashboards[player.index]
	if state and state.frame and state.frame.valid then
		TransactionDashboard.open(player, state.limit)
	end
end

--- Handle GUI click events
function TransactionDashboard.on_gui_click(event)
	local element = event.element
	if not (element and element.valid) then return end
	
	local player = game.players[event.player_index]
	
	-- Limit buttons
	if element.name:match("^transaction_dashboard_limit_") then
		local limit = tonumber(element.name:match("%d+$"))
		if limit then
			TransactionDashboard.open(player, limit)
		end
		
	-- Clear history
	elseif element.name == "transaction_dashboard_clear" then
		if player.admin then
			TransactionHistory.clear()
			TransactionDashboard.open(player, open_dashboards[player.index].limit)
			player.print("[Transaction Dashboard] History cleared")
		end
		
	-- Details button
	elseif element.name:match("^transaction_dashboard_details_") then
		local seq = element.tags and element.tags.transaction_seq
		if seq then
			TransactionDashboard.open_details(player, seq)
		end
		
	-- Close detail popup
	elseif element.name == "transaction_detail_close" then
		if player.gui.screen["transaction_detail_frame"] then
			player.gui.screen["transaction_detail_frame"].destroy()
		end
	end
end

--- Handle GUI closed events
function TransactionDashboard.on_gui_closed(event)
	local element = event.element
	if element and element.name == "transaction_dashboard_frame" then
		local player = game.players[event.player_index]
		TransactionDashboard.close(player)
	end
end

return TransactionDashboard
