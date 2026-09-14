# Verification tools

`tools/verify-workflow.mjs` runs requested checks sequentially and retains command
results and source/candidate identity. `tools/verification-status.mjs` summarizes
local reports and current PR checks; its status is informational, not merge authority.

Use the [workflow guide](../../docs/developers/workflow.md#serial-verification-and-review-evidence)
for commands, fixture-runtime inputs and acceptance scope. Use the
[test guide](../../docs/developers/testing.md) to choose live fixtures.
