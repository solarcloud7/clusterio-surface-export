// testkit / referentialIntegrity — every cross-reference in the repo's test corpus resolves.
//
// WHY THIS EXISTS. One defect class hit FOUR times on 2026-07-26 alone, three of them self-
// inflicted by a single consolidation commit: a deletion left a reference behind.
//   * a fixture's `owningRunner` named a runner the same PR had just deleted
//   * four doc sites named five test directories that had just been folded away
//   * .gitattributes carried LF rules for two files deleted with the Factorio bake
//   * a fixture anchor named an infinity-chest removed from the pad seven days earlier
// Each was found by hand, at a different time, by a different means. None of them is hard to
// detect; the expensive part was that nothing looked. This looks, in one pass.
//
// STATIC checks need no cluster and are safe in CI. LIVE checks (anchors resolve against a real
// export payload) need a running cluster and are opt-in, because a missing cluster must not be
// reported as a passing check — that is a vacuous pass, the failure mode this repo keeps closing.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const REPO_ROOT = new URL("../../", import.meta.url);
const rootPath = () => new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function walk(dir, filter, out = []) {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === ".git" || name === "dist") continue;
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) walk(full, filter, out);
		else if (filter(full)) out.push(full);
	}
	return out;
}

/** owningRunner must name a runner that exists (it is a provenance claim about where a law lives). */
function checkOwningRunners(manifest, findings) {
	for (const fixture of manifest.fixtures) {
		if (typeof fixture.owningRunner !== "string") continue;
		if (!existsSync(new URL(fixture.owningRunner, REPO_ROOT))) {
			findings.push({
				check: "owningRunner", subject: fixture.id,
				detail: `names "${fixture.owningRunner}", which does not exist`,
			});
		}
	}
}

/** A doc naming tests/integration/<dir> must name one that exists. */
function checkDocTestDirRefs(root, findings) {
	const integrationDir = join(root, "tests", "integration");
	const live = new Set(existsSync(integrationDir)
		? readdirSync(integrationDir).filter(n => statSync(join(integrationDir, n)).isDirectory())
		: []);
	for (const file of walk(root, f => f.endsWith(".md"))) {
		const text = readFileSync(file, "utf8");
		for (const m of text.matchAll(/tests\/integration\/([a-z0-9][a-z0-9-]*)/gi)) {
			const name = m[1];
			// A .md filename under tests/integration (e.g. MIGRATION.md) is a file, not a dir.
			if (live.has(name) || existsSync(join(integrationDir, `${name}.md`))) continue;
			findings.push({
				check: "docTestDirRef", subject: relative(root, file).split(sep).join("/"),
				detail: `references tests/integration/${name}, which does not exist`,
			});
		}
	}
}

/**
 * A .gitattributes rule naming a literal path must name something that exists.
 * Two shapes, both real: a rooted path (`docker/ci/Dockerfile.factorio-baked`) resolves directly,
 * while a bare filename (`docker-compose.ci.yml`) matches anywhere in the tree — so it is stale
 * only if NO file in the repo has that basename. Both went stale together when the Factorio bake
 * was deleted; an earlier cut of this check skipped bare names and caught only one of the two.
 */
function checkGitattributesPaths(root, findings, basenames) {
	const file = join(root, ".gitattributes");
	if (!existsSync(file)) return;
	for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const pattern = trimmed.split(/\s+/)[0];
		if (/[*?[\]]/.test(pattern)) continue;      // globs are not path claims
		const exists = pattern.includes("/")
			? existsSync(join(root, pattern))
			: basenames.has(pattern);
		if (!exists) {
			findings.push({
				check: "gitattributesPath", subject: ".gitattributes",
				detail: `rule for "${pattern}", which matches no file in the repository`,
			});
		}
	}
}

/** Every physical_read kind a fixture uses must be registered in the Node allowlist. */
function checkLifecycleReadKinds(root, manifest, findings) {
	const manifestMjs = readFileSync(join(root, "tests", "lab-gallery", "manifest.mjs"), "utf8");
	const block = manifestMjs.match(/PHYSICAL_READS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
	if (!block) {
		findings.push({ check: "readKind", subject: "manifest.mjs", detail: "could not locate PHYSICAL_READS" });
		return;
	}
	const registered = new Set([...block[1].matchAll(/"([^"]+)"/g)].map(m => m[1]));
	for (const fixture of manifest.fixtures) {
		for (const check of fixture.lifecycle?.verify || []) {
			if (check.check !== "physical_read" || !check.read) continue;
			if (!registered.has(check.read)) {
				findings.push({
					check: "readKind", subject: fixture.id,
					detail: `uses physical_read "${check.read}", absent from PHYSICAL_READS`,
				});
			}
		}
	}
}

/**
 * Static pass — no cluster required, safe in CI.
 * Returns { ok, findings, checked } so a caller can print or assert.
 */
export function referentialIntegrityStatic({ root = rootPath() } = {}) {
	const findings = [];
	const manifest = JSON.parse(readFileSync(join(root, "tests", "lab-gallery", "manifest.json"), "utf8"));
	const basenames = new Set(walk(root, () => true).map(f => f.split(sep).at(-1)));
	checkOwningRunners(manifest, findings);
	checkDocTestDirRefs(root, findings);
	checkGitattributesPaths(root, findings, basenames);
	checkLifecycleReadKinds(root, manifest, findings);
	return {
		ok: findings.length === 0,
		findings,
		checked: ["owningRunner", "docTestDirRef", "gitattributesPath", "readKind"],
	};
}

/**
 * Live pass — every fixture anchor must resolve against a real export payload.
 * Requires a running cluster; the caller passes an inspector so this stays composable and so a
 * missing cluster surfaces as a thrown error rather than a silent pass.
 */
export function referentialIntegrityAnchors(inspector, { root = rootPath(), platformName } = {}) {
	const manifest = JSON.parse(readFileSync(join(root, "tests", "lab-gallery", "manifest.json"), "utf8"));
	const findings = [];
	let checkedAnchors = 0;
	for (const fixture of manifest.fixtures) {
		if (platformName && fixture.platformName !== platformName) continue;
		for (const anchor of fixture.anchors || []) {
			checkedAnchors++;
			const hit = inspector.resolveAnchor(anchor);
			if (!hit.ok) {
				findings.push({
					check: "anchor", subject: fixture.id,
					detail: `anchor ${anchor.entity} @ (${anchor.x},${anchor.y}) did not resolve (${hit.reason}` +
						`${hit.delta != null ? `, nearest delta ${hit.delta}` : ""})`,
				});
			} else if (hit.ambiguous) {
				findings.push({
					check: "anchor", subject: fixture.id,
					detail: `anchor ${anchor.entity} @ (${anchor.x},${anchor.y}) is AMBIGUOUS — two same-name ` +
						`entities equidistant; the anchor does not identify one entity`,
				});
			}
		}
	}
	return { ok: findings.length === 0, findings, checkedAnchors };
}

export function formatFindings(result) {
	if (result.ok) return "referential integrity: OK";
	return `referential integrity: ${result.findings.length} finding(s)\n` +
		result.findings.map(f => `  [${f.check}] ${f.subject}: ${f.detail}`).join("\n");
}
