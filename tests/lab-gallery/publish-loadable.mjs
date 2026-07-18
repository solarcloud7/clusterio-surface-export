// Publish-time loadability injection: the isolated bake Factorio strips ALL scenario scripts from
// its saves (measured 2026-07-18: golden zips carry zero .lua entries while a Clusterio-patched
// save carries ~100), and Clusterio's save patcher requires a control.lua whose SHA1 matches a
// KNOWN freeplay scenario (patch.js knownScenarios: 0.17.63 / 2.0.0 / 2.0.29 variants) — an
// arbitrary stub fails with "unknown scenario (<sha1>)". The canonical byte-exact content is the
// engine's own data/base/scenarios/freeplay/control.lua (48 bytes at 2.0.77, SHA1
// 3af547d2f4db3728b75ac5d1b3a4f47830dc48e7 — the "first seen in 2.0.29" known hash), fetched from
// the container at publish time so it can never drift from the pinned engine.
//
// Usage: node tests/lab-gallery/publish-loadable.mjs <save.zip> [<save.zip> ...]
// Idempotent: replaces a root control.lua whose content differs; leaves a matching one untouched.
// The bake pipeline calls this after publishing each artifact and BEFORE hashing.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CONTAINER = "surface-export-host-2";
const FREEPLAY_CONTROL = "/opt/factorio/2.0.77/data/base/scenarios/freeplay/control.lua";

export function fetchFreeplayControl(container = CONTAINER) {
	return execFileSync("docker", ["exec", container, "cat", FREEPLAY_CONTROL], { encoding: "utf8" });
}

export function injectControlLua(zipPath, content) {
	if (!existsSync(zipPath)) throw new Error(`save does not exist: ${zipPath}`);
	if (process.platform !== "win32") {
		// Node has no stdlib zip writer; add the `zip` CLI variant when a non-Windows publisher exists.
		throw new Error("non-Windows injection not implemented yet");
	}
	const encoded = Buffer.from(content, "utf8").toString("base64");
	const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$content = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
$zip = [System.IO.Compression.ZipFile]::Open('${zipPath.replace(/'/g, "''")}', 'Update')
try {
  $root = ($zip.Entries | Select-Object -First 1).FullName -replace '/.*$', ''
  if (-not $root) { throw 'zip has no entries' }
  $existing = $zip.Entries | Where-Object { $_.FullName -eq ($root + '/control.lua') }
  if ($existing) {
    $reader = New-Object System.IO.StreamReader($existing.Open())
    $current = $reader.ReadToEnd()
    $reader.Dispose()
    if ($current -eq $content) { 'already-canonical'; return }
    $existing.Delete()
  }
  $entry = $zip.CreateEntry($root + '/control.lua')
  $writer = New-Object System.IO.StreamWriter($entry.Open())
  $writer.Write($content)
  $writer.Dispose()
  'injected'
} finally { $zip.Dispose() }
`;
	return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).trim();
}

async function main() {
	const targets = process.argv.slice(2);
	if (targets.length === 0) throw new Error("usage: publish-loadable.mjs <save.zip> [...]");
	const content = fetchFreeplayControl();
	for (const target of targets) {
		console.log(`${target}: ${injectControlLua(target, content)}`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(error => { console.error(error); process.exitCode = 1; });
}
