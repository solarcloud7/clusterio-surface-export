#!/usr/bin/env pwsh
# verify-comment-strip.ps1 — run verify-comment-strip.mjs where typescript exists.
# requires: docker; a clean-enough working tree that `git diff --name-only <Ref>` names the stripped files
# produces: exit 0 only when every changed file parses identically before and after the strip
# does not: strip anything, install into the live plugin dir, or touch the running cluster
[CmdletBinding()]
param(
	[string]$Ref = "HEAD",
	[string]$TypeScriptVersion = "5.9.3"
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

$changed = & git -C $repo diff --name-only $Ref
if ($LASTEXITCODE -ne 0) { throw "git diff --name-only $Ref failed" }
$changed = @($changed | Where-Object { $_ -and $_.Trim() })
if ($changed.Count -eq 0) { Write-Host "no files changed against $Ref — nothing to verify"; exit 0 }

$beforeDir = Join-Path ([System.IO.Path]::GetTempPath()) ("sc-before-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $beforeDir | Out-Null
try {
	node (Join-Path $PSScriptRoot "verify-comment-strip.mjs") $Ref --extract-before $beforeDir
	if ($LASTEXITCODE -ne 0) { throw "extracting the pre-strip files from $Ref failed" }

	Write-Host "verifying $($changed.Count) changed file(s) against $Ref ..."

	Write-Host "`n-- host pass (.lua via luaparse, .ps1 via the PowerShell parser) --"
	$env:SC_BEFORE_DIR = $beforeDir
	$env:SC_ONLY = "lua,ps"
	node (Join-Path $PSScriptRoot "verify-comment-strip.mjs")
	$hostExit = $LASTEXITCODE
	Remove-Item env:SC_BEFORE_DIR, env:SC_ONLY

	Write-Host "`n-- container pass (.ts/.tsx/.js/.mjs/.cjs via typescript) --"
	docker run --rm `
		-v "${repo}:/repo" -v "${beforeDir}:/before" `
		-e SC_BEFORE_DIR=/before `
		-e SC_ONLY=js `
		-e NODE_PATH=/usr/local/lib/node_modules `
		-w /repo node:24 `
		sh -c "npm i -g typescript@$TypeScriptVersion --silent >/dev/null 2>&1 && node tools/verify-comment-strip.mjs"
	$containerExit = $LASTEXITCODE

	if ($hostExit -ne 0 -or $containerExit -ne 0) { exit 1 }
	exit 0
} finally {
	Remove-Item -Recurse -Force $beforeDir -ErrorAction SilentlyContinue  # deliberately quiet: temp dir cleanup, its absence is not a finding
}
