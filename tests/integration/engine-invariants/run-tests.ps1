# Shim: wires the engine-invariants INSTRUMENT into the integration suite's auto-discovery.
#
# WHY (2026-08-04 audit): this instrument is the standing guard docs/factorio-2.0-api-notes.md cites
# for the item-counting laws — and a tools-reorg path break left it UNRUNNABLE for weeks with
# nothing noticing. A guard nothing invokes rots invisibly; running it here re-measures the laws on
# every suite run (locally and in CI) and turns the next rot into a RED run instead of silence.
# The instrument itself stays in tests/instruments/ — it is also a hand-run re-measurement tool.
$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "..\..\instruments\engine-invariants\run-tests.ps1")
exit $LASTEXITCODE
