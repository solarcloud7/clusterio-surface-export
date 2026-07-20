// fail-safe-hooks.mjs — the ONE declaration of pre-gate / self-protecting test hooks.
//
// Shared by scripts/lint-test-hooks.mjs (the arm→guaranteed-disarm guard) and
// tests/lab-gallery/manifest.mjs (the lifecycle arm_hook allowlist). Each entry MUST be
// pre-gate: on a leaked flag the next transfer FAILS its gate and PRESERVES its source. Adding
// an entry is a reviewable act — a post-gate/destructive hook here defeats both consumers.
export const FAIL_SAFE_HOOKS = new Set([
	"test_force_item_loss", // pre-gate: inflates the loss the strict gate counts → gate FAILS → source preserved
	"test_force_fluid_loss", // pre-gate: inflates expected fluids before the single exact gate → gate FAILS → dest discarded/source preserved
	"test_force_validation_failure", // pre-gate: forces validation FAIL → rollback → source preserved
	"test_force_entity_failure", // pre-gate: marker forces verdict FAIL after attribution → source preserved
	"test_force_census_omission", // PRE-verdict: source census FAILS → transfer export ABORTS → source preserved
]);

// Non-destructive hooks a lifecycle may also arm (they mutate nothing; leaving one armed leaves
// the next clone deactivated — visible, not lossy).
export const NON_DESTRUCTIVE_HOOKS = new Set([
	"test_defer_clone_activation",
]);
