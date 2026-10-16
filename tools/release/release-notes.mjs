#!/usr/bin/env node
// release-notes — write a GitHub Release body for one release tag from the files checked out at that tag
// requires: a source tree (--root, default this checkout) containing the plugin package.json and CHANGELOG.md, the
//           gateway mod info.json, .env.example and the seed engine pins; --tag v<package version>
// produces: Markdown with the version's CHANGELOG section and a compatibility table (plugin, Clusterio tested version
//           and peer range, gateway mod, Factorio, clusterio-docker image, optional package SHA-256); prerelease=true|false
//           in GITHUB_OUTPUT; exit 1 when the tag, changelog section or engine pins disagree
// does not: read git history or documentation, create or edit a GitHub Release, publish, or prove the pins were tested
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { checkEnginePins } from "../shared/engine-pins.mjs";
import { REPO_ROOT } from "../shared/seeded-instances.mjs";
import versionFormat from "../../docker/seed-data/external_plugins/surface_export/scripts/release-version.cjs";

export const PLUGIN_DIR = "docker/seed-data/external_plugins/surface_export";
export const GATEWAY_INFO = "docker/seed-data/mods-src/surfexp_gateways/info.json";
export const MOD_PORTAL = "https://mods.factorio.com/mod/surfexp_gateways";

export function changelogSection(text, version) {
	const lines = text.replace(/\r/g, "").split("\n");
	const start = lines.findIndex(line => line.trim() === `## ${version}`);
	assert.ok(start >= 0, `CHANGELOG.md has no "## ${version}" section`);
	let end = lines.findIndex((line, index) => index > start && /^## /.test(line));
	if (end < 0) end = lines.length;
	const body = lines.slice(start + 1, end).join("\n").trim();
	assert.ok(body, `CHANGELOG.md section ${version} is empty`);
	return body;
}

export function imageTag(envExample) {
	const tags = [...envExample.replace(/\r/g, "").matchAll(/^CLUSTERIO_IMAGE_TAG=(\S+)\s*$/gm)].map(match => match[1]);
	assert.equal(tags.length, 1, ".env.example must set CLUSTERIO_IMAGE_TAG exactly once");
	return tags[0];
}

function peerRange(peers) {
	const entries = Object.entries(peers ?? {}).filter(([name]) => name.startsWith("@clusterio/"));
	assert.ok(entries.length, "package.json has no @clusterio peer dependency");
	const ranges = [...new Set(entries.map(([, range]) => range))];
	if (ranges.length === 1) return `\`${ranges[0]}\``;
	return entries.map(([name, range]) => `\`${name}\` \`${range}\``).join(", ");
}

export function releaseFacts(read) {
	const manifest = JSON.parse(read(`${PLUGIN_DIR}/package.json`));
	const gateway = JSON.parse(read(GATEWAY_INFO));
	const tested = manifest.devDependencies?.["@clusterio/lib"];
	assert.ok(tested, "package.json has no devDependencies @clusterio/lib");
	assert.ok(gateway.version, "gateway info.json has no version");
	const channel = versionFormat.releaseChannel(manifest.version);
	return {
		name: manifest.name, version: manifest.version, channel, prerelease: channel !== "latest",
		clusterioTested: tested, clusterioPeer: peerRange(manifest.peerDependencies),
		gatewayVersion: gateway.version, gatewayFactorio: gateway.factorio_version,
		imageTag: imageTag(read(".env.example")),
	};
}

export function releaseNotes({ read, enginePin, tag, sha256 }) {
	const facts = releaseFacts(read);
	assert.equal(tag, `v${facts.version}`, `tag ${tag} does not match package version ${facts.version}`);
	assert.match(enginePin ?? "", /^\d+\.\d+\.\d+$/, "seed engine pin unavailable");
	const rows = [
		[`Plugin \`${facts.name}\``, `\`${facts.version}\` (npm \`${facts.channel}\`)`, `\`${PLUGIN_DIR}/package.json\` \`version\``],
		["Clusterio (tested)", `\`${facts.clusterioTested}\``, "`package.json` `devDependencies` `@clusterio/lib`"],
		["Clusterio (supported range)", facts.clusterioPeer, "`package.json` `peerDependencies`"],
		[`Gateway mod [\`surfexp_gateways\`](${MOD_PORTAL})`, `\`${facts.gatewayVersion}\``, `\`${GATEWAY_INFO}\` \`version\``],
		["Factorio Space Age", `\`${enginePin}\`${facts.gatewayFactorio ? ` (gateway mod declares \`${facts.gatewayFactorio}\`)` : ""}`,
			"seed instance `factorio.version`, checked by `tools/shared/engine-pins.mjs`"],
		["clusterio-docker image", `\`${facts.imageTag}\``, "`.env.example` `CLUSTERIO_IMAGE_TAG`"],
	];
	if (sha256) rows.push(["Attached `package.tgz` SHA-256", `\`${sha256}\``, "the tarball published to npm"]);
	return [
		changelogSection(read(`${PLUGIN_DIR}/CHANGELOG.md`), facts.version),
		"",
		"## Compatibility",
		"",
		`Generated from the files at \`${tag}\` by \`tools/release/release-notes.mjs\`.`,
		"",
		"| Component | Version | Source at this tag |",
		"|---|---|---|",
		...rows.map(row => `| ${row.join(" | ")} |`),
		"",
	].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const { values } = parseArgs({ options: {
		root: { type: "string", default: REPO_ROOT }, tag: { type: "string" },
		package: { type: "string" }, out: { type: "string" },
	} });
	assert.ok(values.tag, "usage: node tools/release/release-notes.mjs --tag v<version> [--root <dir>] [--package <tgz>] [--out <file>]");
	const root = resolve(values.root);
	const { pin, problems } = checkEnginePins(root);
	assert.deepEqual(problems, [], "engine pins disagree");
	const read = path => readFileSync(join(root, path), "utf8");
	const sha256 = values.package && createHash("sha256").update(readFileSync(values.package)).digest("hex");
	const notes = releaseNotes({ read, enginePin: pin, tag: values.tag, sha256 });
	if (values.out) writeFileSync(values.out, notes);
	else process.stdout.write(notes);
	if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `prerelease=${releaseFacts(read).prerelease}\n`);
}
