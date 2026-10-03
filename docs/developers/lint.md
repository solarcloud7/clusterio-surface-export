# Lint checks and their limits

Run `./tools/clusterio/build-plugin.ps1 lint` from the repository root. The plugin's
[package scripts](../../docker/seed-data/external_plugins/surface_export/package.json)
select the checks; [guard implementations](../../docker/seed-data/external_plugins/surface_export/scripts/)
define their actual scan boundaries.

| Check family | Detects |
|---|---|
| ESLint | Extracted or cast Clusterio Link methods, empty blocks and catches, and empty `.catch(() => {})` handlers. TypeScript type errors are reported by the build, which `lint` does not run. |
| Lua invariants and syntax | Prohibited persistence/import/identity patterns, parse errors and unexpected globals. |
| Factorio API names | Selected receiver/member names absent from the vendored API index. |
| Web cache | Asset output that would bypass the expected content-hashed publication scheme. |
| Test grounding | Selected success-path tests that omit or order validation/physical observations incorrectly. |
| Lua `pcall`, JS catch and PowerShell error handling | Selected swallowed-error patterns. |
| Test hooks | State-mutating fault hooks without recognized cleanup or a reviewed fail-safe declaration. |
| Tick portability | Selected absolute tick fields crossing instances without relative tick arithmetic. |
| Derived art | Bundled derived images that differ from the configured regeneration output. |
| Allow manifest | `lint-lua:allow`, `pcall:allow`, `lint-webpack-cache:allow` and `lint-test-grounding:allow` markers without a matching manifest entry. |

These are static checks. API scanning infers selected receivers by name; it does
not prove the object's subtype or that a sequence of valid API calls preserves
state. Test-grounding patterns do not replace review of whether two measurements
are independent and comparable. A parse or lint pass is not a Factorio runtime pass.

Exceptions for those four markers need both the marker and a
`scripts/lint-allow-manifest.json` entry, with a reason and approver. The JS catch
(`catch:allow`), tick portability (`tick:allow`), test hook (`lint-test-hooks:allow`)
and PowerShell (`Deliberately quiet`) exceptions are accepted by their own checks. Fix the cause
where possible; an exception is a reviewed change, not a way to silence a failure.
The repository's style policy keeps explanatory prose in requested documentation
and leaves code comments to enforced markers/directives.

For a new guard, demonstrate the faulty output it detects and include legitimate
cases it must accept. Do not add a check that parses documentation to certify a
runtime claim. Evidence belongs in executable observations and retained results.
