data:extend({
	{
		type = "bool-setting",
		name = "surfexp-platform-boarding",
		setting_type = "runtime-global",
		default_value = true,
		order = "b",
	},
	{
		type = "string-setting",
		name = "surfexp-gateway-layout",
		setting_type = "startup",
		default_value = "one_gate",
		allowed_values = { "one_gate", "multi" },
		order = "a",
	},
})
