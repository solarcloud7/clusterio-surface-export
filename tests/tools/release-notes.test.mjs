import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GATEWAY_INFO, MOD_PORTAL, PLUGIN_DIR, changelogSection, imageTag, releaseFacts, releaseNotes }
	from "../../tools/release/release-notes.mjs";

const CHANGELOG = [
	"# Changelog",
	"",
	"Intro text.",
	"",
	"## 1.2.0-beta.3",
	"",
	"- Newest change. (#3)",
	"",
	"## 1.2.0-beta.2",
	"",
	"### Group",
	"",
	"- Middle change. (#2)",
	"",
	"## 1.1.0",
	"",
	"- Oldest change. (#1)",
	"",
].join("\r\n");

function tree({ version = "1.2.0-beta.2", peers, tested = "2.4.6", env = "# images\r\nCLUSTERIO_IMAGE_TAG=2.4.6.r3\r\n" } = {}) {
	const files = {
		[`${PLUGIN_DIR}/package.json`]: JSON.stringify({ name: "@example/plugin", version,
			devDependencies: { "@clusterio/lib": tested, typescript: "^5.0.0" },
			peerDependencies: peers ?? { "@clusterio/controller": "^2.4.0", "@clusterio/lib": "^2.4.0" } }),
		[`${PLUGIN_DIR}/CHANGELOG.md`]: CHANGELOG,
		[GATEWAY_INFO]: JSON.stringify({ name: "surfexp_gateways", version: "0.9.1", factorio_version: "2.3" }),
		".env.example": env,
	};
	return path => {
		assert.ok(path in files, `unexpected read: ${path}`);
		return files[path];
	};
}

test("changelog sections end at the next version heading, including the first and last entries", () => {
	assert.equal(changelogSection(CHANGELOG, "1.2.0-beta.3"), "- Newest change. (#3)");
	assert.equal(changelogSection(CHANGELOG, "1.2.0-beta.2"), "### Group\n\n- Middle change. (#2)");
	assert.equal(changelogSection(CHANGELOG, "1.1.0"), "- Oldest change. (#1)");
});

test("a missing or empty changelog section refuses instead of publishing an empty body", () => {
	assert.throws(() => changelogSection(CHANGELOG, "1.2.0"), /no "## 1\.2\.0" section/);
	assert.throws(() => changelogSection(CHANGELOG, "1.2.0-beta"), /no "## 1\.2\.0-beta" section/);
	assert.throws(() => changelogSection("## 2.0.0\n\n## 1.0.0\n- x\n", "2.0.0"), /section 2\.0\.0 is empty/);
});

test("the image tag comes from exactly one uncommented CLUSTERIO_IMAGE_TAG line", () => {
	assert.equal(imageTag("A=1\r\nCLUSTERIO_IMAGE_TAG=2.0.2.r1\r\n"), "2.0.2.r1");
	assert.throws(() => imageTag("# CLUSTERIO_IMAGE_TAG=2.0.2.r1\n"), /exactly once/);
	assert.throws(() => imageTag("CLUSTERIO_IMAGE_TAG=a\nCLUSTERIO_IMAGE_TAG=b\n"), /exactly once/);
});

test("alpha, beta and rc versions are prereleases; a stable version is not", () => {
	for (const [version, channel] of [["1.2.0-alpha.1", "alpha"], ["1.2.0-beta.2", "beta"], ["1.2.0-rc.1", "rc"]]) {
		const facts = releaseFacts(tree({ version }));
		assert.equal(facts.channel, channel);
		assert.equal(facts.prerelease, true);
	}
	assert.equal(releaseFacts(tree({ version: "1.1.0" })).prerelease, false);
	assert.throws(() => releaseFacts(tree({ version: "1.2.0-preview.1" })), /unsupported release version/);
});

test("the compatibility table reports each pin from its own file", () => {
	const notes = releaseNotes({ read: tree(), enginePin: "2.3.9", tag: "v1.2.0-beta.2", sha256: "f".repeat(64) });
	assert.ok(notes.startsWith("### Group\n\n- Middle change. (#2)\n\n## Compatibility\n"));
	assert.ok(!notes.includes("Newest change") && !notes.includes("Oldest change"));
	assert.match(notes, /Generated from the files at `v1\.2\.0-beta\.2`/);
	const rows = Object.fromEntries(notes.split("\n").filter(line => line.startsWith("| ") && !line.startsWith("| Component"))
		.map(line => line.split(" | ")).map(([name, version]) => [name.slice(2), version]));
	assert.deepEqual(rows, {
		"Plugin `@example/plugin`": "`1.2.0-beta.2` (npm `beta`)",
		"Clusterio (tested)": "`2.4.6`",
		"Clusterio (supported range)": "`^2.4.0`",
		[`Gateway mod [\`surfexp_gateways\`](${MOD_PORTAL})`]: "`0.9.1`",
		"Factorio Space Age": "`2.3.9` (gateway mod declares `2.3`)",
		"clusterio-docker image": "`2.4.6.r3`",
		"Attached `package.tgz` SHA-256": `\`${"f".repeat(64)}\``,
	});
});

test("differing Clusterio peer ranges are listed per package instead of collapsed", () => {
	const facts = releaseFacts(tree({ peers: { "@clusterio/lib": "^2.4.0", "@clusterio/host": "^2.3.0", react: "^18" } }));
	assert.equal(facts.clusterioPeer, "`@clusterio/lib` `^2.4.0`, `@clusterio/host` `^2.3.0`");
	assert.throws(() => releaseFacts(tree({ peers: { react: "^18" } })), /no @clusterio peer dependency/);
});

test("a tag that is not v<package version>, or a missing engine pin, refuses", () => {
	assert.throws(() => releaseNotes({ read: tree(), enginePin: "2.3.9", tag: "v1.2.0-beta.3" }), /does not match package version/);
	assert.throws(() => releaseNotes({ read: tree(), enginePin: "2.3.9", tag: "1.2.0-beta.2" }), /does not match package version/);
	assert.throws(() => releaseNotes({ read: tree(), enginePin: null, tag: "v1.2.0-beta.2" }), /engine pin unavailable/);
	assert.ok(!releaseNotes({ read: tree(), enginePin: "2.3.9", tag: "v1.2.0-beta.2" }).includes("SHA-256"));
});

test("the command writes this checkout's notes and prerelease flag", t => {
	const dir = mkdtempSync(join(tmpdir(), "se-release-notes-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const root = fileURLToPath(new URL("../../", import.meta.url));
	const version = JSON.parse(readFileSync(join(root, PLUGIN_DIR, "package.json"), "utf8")).version;
	const output = join(dir, "github-output");
	const run = spawnSync(process.execPath, ["tools/release/release-notes.mjs", "--tag", `v${version}`, "--out", join(dir, "notes.md")],
		{ cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output } });
	assert.equal(run.status, 0, run.stderr);
	assert.match(readFileSync(join(dir, "notes.md"), "utf8"), /\n## Compatibility\n/);
	assert.match(readFileSync(output, "utf8"), /^prerelease=(true|false)\n$/);
	const refused = spawnSync(process.execPath, ["tools/release/release-notes.mjs", "--tag", "v0.0.0"], { cwd: root, encoding: "utf8" });
	assert.notEqual(refused.status, 0);
	assert.match(refused.stderr, /does not match package version/);
});
