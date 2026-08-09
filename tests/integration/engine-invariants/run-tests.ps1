$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "..\..\instruments\engine-invariants\run-tests.ps1")
exit $LASTEXITCODE
