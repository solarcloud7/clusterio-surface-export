# Lint checks and their limits

Run `./tools/clusterio/build-plugin.ps1 lint` from the repository root. The plugin's
[package scripts](../../docker/seed-data/external_plugins/surface_export/package.json)
select the checks; [guard implementations](../../docker/seed-data/external_plugins/surface_export/scripts/)
define their actual scan boundaries.

| Check family | Detects |
|---|---|
| TypeScript/ESLint | Type and usage errors, including selected unbound-method and empty-catch patterns. |
| Lua invariants and syntax | Prohibited persistence/import/identity patterns, parse errors and unexpected globals. |
| Factorio API names | Selected receiver/member names absent from the vendored API index. |
| Web cache | Asset output that would bypass the expected content-hashed publication scheme. |
| Test grounding | Selected success-path tests that omit or order validation/physical observations incorrectly. |
| Lua `pcall`, JS catch and PowerShell error handling | Selected swallowed-error patterns. |
| Test hooks | State-mutating fault hooks without recognized cleanup or a reviewed fail-safe declaration. |
| Tick portability | Selected absolute tick fields crossing instances without relative tick arithmetic. |
| Derived art | Bundled derived images that differ from the configured regeneration output. |
| Allow manifest | Unregistered exceptions to the checks above. |

These are static checks. API scanning infers selected receivers by name; it does
not prove the object's subtype or that a sequence of valid API calls preserves
state. Test-grounding patterns do not replace review of whether two measurements
are independent and comparable. A parse or lint pass is not a Factorio runtime pass.

Exceptions use the existing machine-readable marker and
`scripts/lint-allow-manifest.json` entry, with a reason and approver. Fix the cause
where possible; an exception is a reviewed change, not a way to silence a failure.
The repository's style policy keeps explanatory prose in requested documentation
and leaves code comments to enforced markers/directives.

For a new guard, demonstrate the faulty output it detects and include legitimate
cases it must accept. Do not add a check that parses documentation to certify a
runtime claim. Evidence belongs in executable observations and retained results.
