// push-roster.mjs — build the trimmed test roster from manifest.json and push it to the LIVE
// gallery instance (P3 of the pad-lifecycle plan). The roster is the trust anchor /test-run
// reconciles against: a rostered fixture with no live pad is a RED MISSING failure.
//
// Transport: always the chunked protocol (set_test_roster_begin/chunk/commit) when the payload
// exceeds SINGLE_LIMIT, single-shot set_test_roster otherwise. Commit routes through the SAME
// validation as the single-shot path Lua-side, so the two transports cannot drift.
//
// Usage:
//   node tests/lab-gallery/push-roster.mjs           # push + echo-verify
//   node tests/lab-gallery/push-roster.mjs --dry-run # print payload stats, push nothing

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadGalleryManifest, validateGalleryManifest } from "./manifest.mjs";

const GALLERY_INSTANCE = "surface-export-lab-gallery";
const CONTROLLER = "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";

// Plan adjudication: single-shot only for tiny rosters; anything real exercises the chunk path.
const SINGLE_LIMIT = 3_000;
const CHUNK_SIZE = 40_000;

// Only these fields ride to the runner — the manifest carries builder-time data (testCard text,
// artifact SHAs, notes) the runner must never depend on.
const ROSTER_FIELDS = [
	"id", "name", "padKind", "platformName", "surfaceName", "origin", "anchors",
	"fingerprint", "runnerExcluded", "lifecycle", "pasteExclude",
];

function trimFixture(fixture) {
	const out = {};
	for (const key of ROSTER_FIELDS) {
		if (fixture[key] !== undefined) out[key] = fixture[key];
	}
	return out;
}

// Deterministic serialization (sorted keys, recursively) so the hash is stable across manifest
// key-order churn. Arrays keep their order — fixture order is meaningful display order.
function stableStringify(value) {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		const keys = Object.keys(value).sort();
		return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

function rcon(command) {
	return execFileSync("docker", ["exec", CONTROLLER, "npx", "clusterioctl", "--log-level", "error",
		"instance", "send-rcon", GALLERY_INSTANCE, command, "--config", CTL_CONFIG],
	{ encoding: "utf8", timeout: 180_000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 }).trim();
}

// JSON-wrapped Lua op (the batch-lifecycle convention): pcall, print JSON, throw on garbage.
function lua(body) {
	const command = `/sc local ok,result=pcall(function() ${body} end); ` +
		`if ok then rcon.print(helpers.table_to_json(result)) else rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) end`;
	const raw = rcon(command).split(/\r?\n/).map(l => l.trim()).filter(Boolean).at(-1) || "";
	try { return JSON.parse(raw); }
	catch (error) { throw new Error(`Invalid Lua JSON from gallery: ${raw}\n${error.message}`); }
}

// Pick a long-bracket level whose closer does not occur in the payload (JSON can legally contain
// "]=]"-shaped substrings inside strings — never assume a fixed level).
function bracketWrap(text) {
	for (let level = 1; level < 10; level++) {
		const eq = "=".repeat(level);
		if (!text.includes(`]${eq}]`)) return `[${eq}[${text}]${eq}]`;
	}
	throw new Error("no safe long-bracket level found for payload chunk");
}

function pushRoster(json, hash) {
	const bytes = Buffer.byteLength(json, "utf8");
	if (bytes !== json.length) {
		// Lua # counts bytes; the commit length check compares against byte length. Fixture text is
		// ASCII today — fail loud rather than silently mismatching if that ever changes.
		throw new Error(`roster contains non-ASCII text (${bytes} bytes vs ${json.length} chars) — ` +
			"commit length check would need byte-accurate chunking");
	}
	if (json.length <= SINGLE_LIMIT) {
		const res = lua(`return remote.call('surface_export','set_test_roster',${bracketWrap(json)},'${hash}')`);
		if (!res.ok) throw new Error(`set_test_roster refused: ${JSON.stringify(res)}`);
		return { transport: "single", commands: 1, result: res };
	}
	const begin = lua(`return remote.call('surface_export','set_test_roster_begin','${hash}')`);
	if (!begin.ok) throw new Error(`set_test_roster_begin refused: ${JSON.stringify(begin)}`);
	let commands = 1;
	for (let i = 0; i < json.length; i += CHUNK_SIZE) {
		const part = json.slice(i, i + CHUNK_SIZE);
		const res = lua(`return remote.call('surface_export','set_test_roster_chunk',${bracketWrap(part)})`);
		commands++;
		if (!res.ok) throw new Error(`set_test_roster_chunk #${commands - 1} refused: ${JSON.stringify(res)}`);
	}
	const commit = lua(`return remote.call('surface_export','set_test_roster_commit',${json.length})`);
	commands++;
	if (!commit.ok) throw new Error(`set_test_roster_commit refused: ${JSON.stringify(commit)}`);
	return { transport: "chunked", commands, result: commit };
}

function main() {
	const dryRun = process.argv.includes("--dry-run");
	const manifest = loadGalleryManifest(new URL("../../", import.meta.url));
	// Artifact SHA freshness is the snapshot pipeline's concern, not the pusher's — the roster is
	// built from fixture declarations only.
	const problems = validateGalleryManifest(manifest, { requireArtifacts: false });
	if (problems.length) {
		console.error("manifest validation FAILED:");
		for (const p of problems) console.error(`  - ${p}`);
		process.exit(1);
	}

	const fixtures = manifest.fixtures.map(trimFixture);
	const json = stableStringify({ schema: manifest.schema, fixtures });
	const hash = createHash("sha256").update(json, "utf8").digest("hex").slice(0, 12);
	console.log(`roster: ${fixtures.length} fixtures, ${json.length} bytes, hash=${hash}, ` +
		`transport=${json.length <= SINGLE_LIMIT ? "single" : `chunked (${Math.ceil(json.length / CHUNK_SIZE)} chunks)`}`);
	if (dryRun) return;

	const pushed = pushRoster(json, hash);
	console.log(`pushed via ${pushed.transport} in ${pushed.commands} command(s): ${JSON.stringify(pushed.result)}`);

	// Echo-verify: the stored roster must report OUR hash and count — never trust a silent push.
	const summary = lua(`return remote.call('surface_export','get_test_roster_summary')`);
	if (summary.hash !== hash || summary.fixtureCount !== fixtures.length) {
		console.error(`echo-verify FAILED: expected hash=${hash} count=${fixtures.length}, ` +
			`got ${JSON.stringify(summary)}`);
		process.exit(1);
	}
	console.log(`echo-verify OK: hash=${summary.hash} fixtureCount=${summary.fixtureCount} pushedTick=${summary.pushedTick}`);
}

main();
