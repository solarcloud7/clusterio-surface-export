import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const REPO_ROOT = new URL("../../../", import.meta.url);
const rootPath = () => new URL("../../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

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

function checkDocTestDirRefs(root, findings) {
	const integrationDir = join(root, "tests", "integration");
	const live = new Set(existsSync(integrationDir)
		? readdirSync(integrationDir).filter(n => statSync(join(integrationDir, n)).isDirectory())
		: []);
	for (const file of walk(root, f => f.endsWith(".md"))) {
		const text = readFileSync(file, "utf8");
		for (const m of text.matchAll(/tests\/integration\/([a-z0-9][a-z0-9-]*)/gi)) {
			const name = m[1];
			if (live.has(name) || existsSync(join(integrationDir, `${name}.md`))) continue;
			findings.push({
				check: "docTestDirRef", subject: relative(root, file).split(sep).join("/"),
				detail: `references tests/integration/${name}, which does not exist`,
			});
		}
	}
}

function checkGitattributesPaths(root, findings, basenames) {
	const file = join(root, ".gitattributes");
	if (!existsSync(file)) return;
	for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const pattern = trimmed.split(/\s+/)[0];
		if (/[*?[\]]/.test(pattern)) continue;
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
