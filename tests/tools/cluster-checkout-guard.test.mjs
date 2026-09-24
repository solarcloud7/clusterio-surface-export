import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const skip = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" }).status !== 0 ? "requires pwsh" : false;
const utils = fileURLToPath(new URL("../../tools/shared/cluster-utils.ps1", import.meta.url));
const here = join(tmpdir(), "checkout-guard", "main");
const elsewhere = join(tmpdir(), "checkout-guard", "other");

function guard({ rows = [], dockerExit = 0, linked = false, gitExit = 0, root = here }) {
	const command = `
. $env:GUARD_UTILS
$fixture = $env:GUARD_FIXTURE | ConvertFrom-Json
$global:calls = [Collections.Generic.List[string]]::new()
function docker { $global:calls.Add('docker ' + ($args -join ' ')); $global:LASTEXITCODE = $fixture.dockerExit; $fixture.rows }
function git {
 $global:calls.Add('git ' + ($args -join ' ')); $global:LASTEXITCODE = $fixture.gitExit
 if ($fixture.linked) { '/fixture/.git/worktrees/other'; '/fixture/.git' } else { '/fixture/.git'; '/fixture/.git' }
}
$failure = $null
try { Assert-DevelopmentClusterCheckout -Root $fixture.root } catch { $failure = $_.Exception.Message }
@{ error = $failure; calls = @($global:calls) } | ConvertTo-Json -Compress
`;
	const result = spawnSync("pwsh", ["-NoProfile", "-Command", command], { encoding: "utf8", env: { ...process.env,
		GUARD_UTILS: utils, GUARD_FIXTURE: JSON.stringify({ rows, dockerExit, linked, gitExit, root }) } });
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

test("the checkout the cluster runs from may deploy, whatever its path spelling", { skip }, () => {
	for (const spelling of [here, `${here.toUpperCase()}${process.platform === "win32" ? "\\" : "/"}`]) {
		const result = guard({ rows: ["atlas-controller|/elsewhere", `surface-export-controller|${spelling}`,
			`surface-export-host-1|${here}`, `surface-export-host-2|${here}`] });
		assert.equal(result.error, null, spelling);
		assert.ok(result.calls.every(call => call.startsWith("docker ps")), JSON.stringify(result.calls));
	}
});

test("a checkout the cluster does not run from is refused and told where to deploy", { skip }, () => {
	for (const container of ["surface-export-controller", "surface-export-host-2"]) {
		const rows = [`surface-export-controller|${here}`, `surface-export-host-1|${here}`, `surface-export-host-2|${here}`]
			.map(row => row.startsWith(container) ? `${container}|${elsewhere}` : row);
		const result = guard({ rows });
		assert.match(result.error, new RegExp(`\\(${container}\\) runs from .*other, not from this checkout`));
		assert.match(result.error, /Nothing was changed/);
	}
});

test("a cluster container without a compose checkout label is refused", { skip }, () => {
	const result = guard({ rows: ["surface-export-controller|"] });
	assert.match(result.error, /surface-export-controller was not started by docker compose/);
});

test("with no cluster, only the main checkout may start one", { skip }, () => {
	assert.equal(guard({ rows: ["atlas-controller|/elsewhere"] }).error, null);
	assert.match(guard({ rows: [], linked: true }).error, /No development cluster exists and .* is a linked worktree/);
	assert.match(guard({ rows: [], gitExit: 128 }).error, /Cannot tell whether .* is the main checkout \(git exit 128\)/);
});

test("an unreadable Docker state is refused rather than treated as no cluster", { skip }, () => {
	const result = guard({ dockerExit: 1 });
	assert.match(result.error, /docker ps failed \(exit 1\)/);
	assert.ok(!result.calls.some(call => call.startsWith("git")));
});
