"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const scriptUrl = pathToFileURL(path.join(__dirname, "..", "scripts", "lint-brief-discipline.mjs")).href;
const disciplineLink = "[Agent execution discipline](../../AGENT_EXECUTION_DISCIPLINE.md)";

async function check(files) {
	const { findBriefDisciplineViolations } = await import(scriptUrl);
	return findBriefDisciplineViolations(files);
}

test("brief-discipline guard flags added and modified briefs without the canonical link", async () => {
	const violations = await check([
		{ status: "A", path: "docs/superpowers/plans/new-agent-brief.md", content: "# New brief\n" },
		{ status: "M", path: "docs/superpowers/plans/changed-brief.md", content: "# Changed brief\n" },
	]);

	assert.deepEqual(violations.map((entry) => entry.path), [
		"docs/superpowers/plans/new-agent-brief.md",
		"docs/superpowers/plans/changed-brief.md",
	]);
});

test("brief-discipline guard accepts a changed brief that links the canonical discipline", async () => {
	assert.deepEqual(await check([
		{
			status: "M",
			path: "docs/superpowers/plans/queued-agent-brief.md",
			content: `# Queued brief\n\n> Standing discipline: ${disciplineLink}.\n`,
		},
	]), []);
});

test("brief-discipline guard ignores unrelated files and deleted or unchanged historical briefs", async () => {
	assert.deepEqual(await check([
		{ status: "A", path: "docs/superpowers/plans/design.md", content: "# Design\n" },
		{ status: "D", path: "docs/superpowers/plans/old-agent-brief.md", content: "" },
		{ status: "", path: "docs/superpowers/plans/unchanged-agent-brief.md", content: "# Historical\n" },
		{ status: "M", path: "README.md", content: "# Readme\n" },
	]), []);
});
