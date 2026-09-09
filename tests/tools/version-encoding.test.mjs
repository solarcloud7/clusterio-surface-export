import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const skip = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" }).status !== 0;
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
