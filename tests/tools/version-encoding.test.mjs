import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

test("plugin stamp test runs without repository-root tools", t => {
	const dir = mkdtempSync(join(tmpdir(), "standalone-plugin-test-"));
	t.after(() => rmSync(dir, { recursive:true, force:true }));
	const source = new URL("../../docker/seed-data/external_plugins/surface_export/", import.meta.url);
	for (const sub of ["module", "scripts", "test"]) mkdirSync(join(dir, sub));
	for (const file of ["package.json", "module/module.json", "module/version.lua", "scripts/release-version.cjs", "test/module-version-stamp.test.cjs"]) {
		copyFileSync(new URL(file, source), join(dir, file));
	}
	const result = spawnSync(process.execPath, ["--test", "test/module-version-stamp.test.cjs"], {cwd:dir, encoding:"utf8"});
	assert.equal(result.status, 0, result.stdout + result.stderr);
});
const skip = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" }).status !== 0;
test("freshness rejects stale Lua with the same public version and missing build IDs", {skip}, t => {
	const dir = mkdtempSync(join(tmpdir(), "module-build-"));
	t.after(() => rmSync(dir, {recursive:true, force:true}));
	const command = `
		$ErrorActionPreference = 'Stop'
		. $env:VERSION_HELPER
		$first = Update-ModuleBuildStamp $env:MODULE_DIR
		$second = Update-ModuleBuildStamp $env:MODULE_DIR
		$version = '0.11.0-beta.1'
		$old = @{version=$version;buildId=$first} | ConvertTo-Json -Compress
		$current = @{version=$version;buildId=$second} | ConvertTo-Json -Compress
		[ordered]@{
			different = $first -cne $second
			old = Test-ModuleDeploymentResponse $old $version $second
			current = Test-ModuleDeploymentResponse ("log line"+[char]10+$current) $version $second
			missing = Test-ModuleDeploymentResponse '{"version":"0.11.0-beta.1"}' $version $second
			invalid = Test-ModuleDeploymentResponse '{invalid' $version $second
			wrongVersion = Test-ModuleDeploymentResponse $current '0.11.0-beta.2' $second
			plainVersion = Test-ModuleDeploymentResponse $version $version $second
			stamp = [IO.File]::ReadAllText((Join-Path $env:MODULE_DIR 'build-id.lua')) -ceq ("return " + [char]34 + $second + [char]34 + [char]10)
		} | ConvertTo-Json -Compress
	`;
	const result = spawnSync("pwsh", ["-NoProfile", "-Command", command], {encoding:"utf8", env:{...process.env,
		VERSION_HELPER:fileURLToPath(new URL("../../tools/shared/version-utils.ps1", import.meta.url)), MODULE_DIR:dir}});
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), {different:true, old:false, current:true, missing:false,
		invalid:false, wrongVersion:false, plainVersion:false, stamp:true});
});
test("deployment refuses automatic prerelease bumps and recognizes version replies", { skip }, () => {
	const command = `
		$ErrorActionPreference = 'Stop'
		. $env:VERSION_HELPER
		$versions = '0.10.281', '0.11.0-alpha.9', '0.11.0-beta.1', '0.11.0-rc.0'
		$invalid = '0.11.0-beta', '0.11.0-beta.01', '0.11.0-preview.1', '01.2.3'
		[ordered]@{
			next = @($versions | ForEach-Object { try { Get-NextPluginVersion $_ } catch { 'explicit release required' } })
			reported = @($versions | ForEach-Object { Get-ModuleVersionResponse ("log line" + [char]10 + $_ + [char]10) })
			missing = Get-ModuleVersionResponse 'plugin-missing'
			stale = Get-ModuleVersionResponse 'stale-module-no-version-oracle'
			rejected = @($invalid | ForEach-Object { try { Get-NextPluginVersion $_ } catch { 'rejected' } })
		} | ConvertTo-Json -Compress
	`;
	const result = spawnSync("pwsh", ["-NoProfile", "-Command", command], { encoding: "utf8", env: { ...process.env,
		VERSION_HELPER: fileURLToPath(new URL("../../tools/shared/version-utils.ps1", import.meta.url)) } });
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), {
		next: ["0.10.282", "explicit release required", "explicit release required", "explicit release required"],
		reported: ["0.10.281", "0.11.0-alpha.9", "0.11.0-beta.1", "0.11.0-rc.0"],
		missing: null, stale: "stale-module-no-version-oracle", rejected: Array(4).fill("rejected"),
	});
});
test("version editing preserves Unicode and LF/CRLF bytes outside the version", { skip }, t => {
	const dir = mkdtempSync(join(tmpdir(), "version-encoding-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	for (const newline of ["\n", "\r\n"]) {
		const path = join(dir, "module.json");
		const input = ['{', '  "name": "Gateway → Nauvis · 工程",', '  "version": "1.2.3"', '}', ''].join(newline);
		writeFileSync(path, input, "utf8");
		const command = '. $env:VERSION_HELPER; Update-JsonVersion -Path $env:VERSION_FIXTURE -NewVersion 1.2.4';
		const result = spawnSync("pwsh", ["-NoProfile", "-Command", command], { encoding: "utf8", env: { ...process.env,
			VERSION_HELPER: fileURLToPath(new URL("../../tools/shared/version-utils.ps1", import.meta.url)), VERSION_FIXTURE: path } });
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(readFileSync(path), Buffer.from(input.replace('"1.2.3"', '"1.2.4"'), "utf8"));
	}
});
