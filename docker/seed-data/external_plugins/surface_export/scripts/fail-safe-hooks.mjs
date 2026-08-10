export const FAIL_SAFE_HOOKS = new Set([
	"test_force_item_loss",
	"test_force_fluid_loss",
	"test_force_validation_failure",
	"test_force_entity_failure",
	"test_force_census_omission",
	"test_force_property_omission",
]);

export const NON_DESTRUCTIVE_HOOKS = new Set([
	"test_defer_clone_activation",
]);
