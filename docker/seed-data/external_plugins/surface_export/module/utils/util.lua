-- FactorioSurfaceExport - Utility Functions (Compatibility Layer)
-- This module re-exports functions from specialized utility modules for backward compatibility

local JsonCompat = require("modules/surface_export/utils/json-compat")
local TableUtils = require("modules/surface_export/utils/table-utils")
local StringUtils = require("modules/surface_export/utils/string-utils")
local GameUtils = require("modules/surface_export/utils/game-utils")

local Util = {}

-- Re-export string utilities
Util.format_timestamp = StringUtils.format_timestamp
Util.sanitize_filename = StringUtils.sanitize_filename
Util.simple_checksum = StringUtils.simple_checksum

-- Re-export table utilities
Util.table_deep_copy = TableUtils.deep_copy
Util.is_table_empty = TableUtils.is_empty
Util.table_merge = TableUtils.merge
Util.sum_items = TableUtils.sum_items
Util.sum_fluids = TableUtils.sum_fluids
Util.is_array = TableUtils.is_array

-- Re-export game utilities
Util.round_position = GameUtils.round_position
Util.get_entity_category = GameUtils.get_entity_category
Util.make_quality_key = GameUtils.make_quality_key
Util.make_fluid_temp_key = GameUtils.make_fluid_temp_key
Util.parse_fluid_temp_key = GameUtils.parse_fluid_temp_key
Util.HIGH_TEMP_THRESHOLD = GameUtils.HIGH_TEMP_THRESHOLD
Util.parse_quality_key = GameUtils.parse_quality_key
Util.debug_log = GameUtils.debug_log
Util.ACTIVATABLE_ENTITY_TYPES = GameUtils.ACTIVATABLE_ENTITY_TYPES
Util.BELT_ENTITY_TYPES = GameUtils.BELT_ENTITY_TYPES
Util.make_stable_id = GameUtils.make_stable_id
Util.safe_get = GameUtils.safe_get
Util.extract_color = GameUtils.extract_color

-- Re-export JSON/file compatibility
Util.to_json = JsonCompat.to_json
Util.encode_json_compat = JsonCompat.encode_json_compat
Util.json_to_table_compat = JsonCompat.json_to_table_compat
Util.write_file_compat = JsonCompat.write_file_compat
Util.read_file_compat = JsonCompat.read_file_compat

return Util
