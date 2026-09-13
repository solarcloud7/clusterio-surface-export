import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const python = ["python3", "python"].find(command => spawnSync(command, ["--version"], {stdio:"ignore"}).status === 0);
test("gateway release artifact and upload protocol", {skip:!python}, () => {
	const result = spawnSync(python, [fileURLToPath(new URL("./gateway-mod.test.py", import.meta.url))], {encoding:"utf8"});
	assert.equal(result.status, 0, result.stdout + result.stderr);
});
