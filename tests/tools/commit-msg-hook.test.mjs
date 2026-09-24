import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const hooks = fileURLToPath(new URL("../../.githooks", import.meta.url));

function commit(t, message, ...options) {
	const dir = mkdtempSync(join(tmpdir(), "commit-msg-hook-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const git = (...args) => spawnSync("git", ["-C", dir, "-c", `core.hooksPath=${hooks}`, "-c", "user.name=fixture",
		"-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args],
	{ encoding: "utf8", env: { ...process.env, GIT_EDITOR: "true" } });
	assert.equal(git("init", "--quiet").status, 0);
	writeFileSync(join(dir, "message.txt"), message);
	const result = git("commit", "--allow-empty", "--quiet", ...options, "-F", join(dir, "message.txt"));
	return { ...result, log: git("log", "--format=%B").stdout };
}

test("an ordinary message commits", t => {
	const result = commit(t, "Guard deployment tools\n\nClaude and Codex sessions share this machine.\n");
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.log, /Guard deployment tools/);
});

for (const line of [
	"Claude-Session: 01AbCdEf",
	"https://claude.ai/code/session_01AbCdEf",
	"https://chatgpt.com/codex/tasks/task_e_0123456789",
	"🤖 Generated with [Claude Code](https://claude.com/claude-code)",
	"Co-Authored-By: Claude <noreply@anthropic.com>",
	"co-authored-by: Codex <codex@openai.com>",
	"# https://claude.ai/code/session_01AbCdEf",
]) {
	test(`the hook refuses "${line}" and names it`, t => {
		const result = commit(t, `Guard deployment tools\n\n${line}\n`);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /commit-msg: refused/);
		assert.ok(result.stderr.includes(line), result.stderr);
		assert.equal(result.log, "");
	});
}

test("a diff below the scissors line of an edited message is not part of the message", t => {
	const result = commit(t, "Guard deployment tools\n# ------------------------ >8 ------------------------\n"
		+ "+  \"https://claude.ai/code/session_01AbCdEf\",\n", "--edit", "--cleanup=scissors");
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.log, /session_/);
});
