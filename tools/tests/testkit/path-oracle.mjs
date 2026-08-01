// path-oracle.mjs — resolve a dotted path through a record, and when it MISSES, name the real path.
//
// WHY THIS EXISTS. Querying a transaction log or a debug dump with a wrong path returned an empty
// value, not an error. That happened three times in one session, and once it produced a false
// conclusion — "the transaction log isn't being written" — when the log was fine and the path was a
// typo. An empty result and an absent feature are indistinguishable, which is what makes the class
// expensive: the tool answers, so you believe it.
//
// So the value of this module is entirely in the MISS path. A resolution is trivial; naming the real
// key is the product.
//
// WHY IT IS A SIBLING OF export-inspect.mjs's `dig()` AND NOT AN EXTENSION OF IT. The two callers
// have different verdict lattices. In `inspect --field`, "not found" is a legitimate exit-1 FINDING:
// the payload is the only thing the destination ever sees, so an absent field is a data-loss claim.
// Here, "not found" is never a finding — it is a wrong path or a schema-version fact, and always an
// operational error. One function serving two lattices needs a flag that changes its semantics,
// which is the construct that rots. `dig`'s deliberately-not-fuzzy rationale is also a decision
// record earned by a real false-loss incident; widening it for a different caller's benefit would
// change the risk profile of a tool whose stated contract is that it must not manufacture findings.
//
// This module is PURE: no I/O, no process.exit. It is testable with the cluster down.

/**
 * Case- and underscore-insensitive key identity. `totalTicks` and `total_ticks` are the same key.
 *
 * This is EXACT-AFTER-NORMALIZATION, not fuzzy. `totalTick` does NOT match `total_ticks`, and
 * `total` does not either. That is the design, not a limitation: a fuzzy matcher will eventually
 * print a "real path" that is not the caller's field, and the sole value of this module is that the
 * path it names is the right one. A near-miss it cannot prove is reported as no match.
 */
export function normalizeKey(key) {
	return String(key).toLowerCase().replace(/_/g, "");
}

const isPlainObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

/** Cap on how many distinct element keys are unioned before reporting truncation. */
const ELEMENT_KEY_CAP = 200;

/**
 * Describe a container for the miss message.
 *
 * For an ARRAY this never reports numeric indices — `Object.keys(events)` on a 400-event log yields
 * 400 useless numbers. It reports the length plus the UNION of element keys, union rather than
 * first-element because event objects carry a `...data` spread: `importMetrics` lives on exactly one
 * event, and a first-element sample would hide it.
 */
export function describeContainer(value) {
	if (Array.isArray(value)) {
		const keys = new Set();
		let truncated = false;
		for (const element of value) {
			if (!isPlainObject(element)) continue;
			for (const key of Object.keys(element)) {
				if (keys.size >= ELEMENT_KEY_CAP) { truncated = true; break; }
				keys.add(key);
			}
			if (truncated) break;
		}
		return { kind: "array", count: value.length, keys: [...keys], keysTruncated: truncated };
	}
	if (isPlainObject(value)) return { kind: "object", keys: Object.keys(value) };
	return { kind: value === null ? "null" : typeof value, keys: [] };
}

/**
 * Search a subtree for a key matching `target` after normalization — the wrong-SUBTREE case
 * (`summary.phaseSpans` really lives at `summary.import.phaseSpans`).
 *
 * DEPTH BOUND: 3 OBJECT levels below the start container. Array-element descent does NOT consume a
 * level, so `a.b[].c` is reachable at depth 3. Three is where the real shapes land:
 *   summary.phaseSpans        -> summary.import.phaseSpans                                (2)
 *   summary.durationMs        -> summary.import.phaseSpans[].durationMs                   (3)
 *   summary.fluidPreservedPct -> summary.validation.fluidReconciliation.fluidPreservedPct  (3)
 * Depth 5 starts returning hits from summary.validation.expectedItemCounts / actualFluidCounts,
 * which are keyed by ITEM AND FLUID NAMES — user data, not schema. Relocating into user data
 * manufactures garbage paths, which is the one thing this module must never do.
 */
function relocate(root, target, { maxDepth = 3, maxResults = 8, nodeBudget = 50_000 }) {
	const wanted = normalizeKey(target);
	const found = [];
	let visited = 0;
	let budgetExhausted = false;
	let resultsTruncated = false;

	const walk = (node, prefix, depth) => {
		if (budgetExhausted || resultsTruncated) return;
		if (++visited > nodeBudget) { budgetExhausted = true; return; }

		if (Array.isArray(node)) {
			// Arrays are traversed without consuming a depth level, and the reported path uses the
			// FIRST concrete index plus a presence count — a concrete path is directly re-runnable,
			// where a wildcard would just make the caller do a second lookup.
			const hitIndices = [];
			for (const [index, element] of node.entries()) {
				if (isPlainObject(element) && Object.keys(element).some(k => normalizeKey(k) === wanted)) {
					hitIndices.push(index);
				}
			}
			if (hitIndices.length) {
				const key = Object.keys(node[hitIndices[0]]).find(k => normalizeKey(k) === wanted);
				found.push({
					path: `${prefix}.${hitIndices[0]}.${key}`,
					note: `present on ${hitIndices.length} of ${node.length} elements`,
				});
				if (found.length >= maxResults) { resultsTruncated = true; return; }
			}
			for (const [index, element] of node.entries()) {
				if (isPlainObject(element) || Array.isArray(element)) walk(element, `${prefix}.${index}`, depth);
			}
			return;
		}

		if (!isPlainObject(node) || depth > maxDepth) return;
		for (const [key, value] of Object.entries(node)) {
			const path = prefix ? `${prefix}.${key}` : key;
			if (depth >= 1 && normalizeKey(key) === wanted) {
				found.push({ path, note: null });
				if (found.length >= maxResults) { resultsTruncated = true; return; }
			}
			if (isPlainObject(value) || Array.isArray(value)) walk(value, path, depth + 1);
		}
	};

	walk(root, "", 0);
	// Dedupe by resolved path; a key reachable twice is one answer.
	const seen = new Set();
	const unique = found.filter(hit => !seen.has(hit.path) && seen.add(hit.path));
	return { hits: unique, budgetExhausted, resultsTruncated };
}

/**
 * Walk `path` through `root`.
 *
 * Returns `{ ok: true, value, path }` or `{ ok: false, reason, stoppedAt, failedSegment,
 * container, nearMisses, relocations, ... }`. `ok` is STRICTLY boolean — never null, never absent.
 * That is deliberate: cli.mjs's `inspect --field` has an exit-0 hole precisely because its
 * equivalent flag is tri-state while the dispatcher handles two states, so the third case falls
 * through to a success exit. A boolean discriminant makes that unrepresentable here.
 *
 * `stoppedAt` is the last path that DID resolve — not the segment that failed. The failed segment is
 * reported separately as `failedSegment`.
 */
export function resolvePath(root, path, options = {}) {
	const raw = String(path ?? "");
	if (!raw) {
		return { ok: false, reason: "empty-path", stoppedAt: "(root)", failedSegment: null,
			container: describeContainer(root), nearMisses: [], relocations: [] };
	}
	const segments = raw.split(".");
	if (segments.some(segment => segment === "")) {
		return { ok: false, reason: "malformed-path", stoppedAt: "(root)", failedSegment: null,
			container: describeContainer(root), nearMisses: [], relocations: [],
			detail: `"${raw}" has an empty segment — a leading, trailing or doubled dot` };
	}

	let cursor = root;
	for (const [index, segment] of segments.entries()) {
		const stoppedAt = index === 0 ? "(root)" : segments.slice(0, index).join(".");
		const miss = (reason, detail) => {
			const container = describeContainer(cursor);
			const wanted = normalizeKey(segment);
			const nearMisses = container.keys
				.filter(key => normalizeKey(key) === wanted)
				.map(key => (stoppedAt === "(root)" ? key : `${stoppedAt}.${key}`));
			// Relocation only when the same level offered nothing: a same-level hit is the higher
			// confidence answer and the camel/snake case this module was built for.
			const relocated = nearMisses.length
				? { hits: [], budgetExhausted: false, resultsTruncated: false }
				: relocate(cursor, segment, options);
			const prefix = stoppedAt === "(root)" ? "" : `${stoppedAt}.`;
			return {
				ok: false, reason, stoppedAt, failedSegment: segment, container, detail,
				nearMisses,
				relocations: relocated.hits.map(hit => ({ ...hit, path: `${prefix}${hit.path}` })),
				searchDepth: options.maxDepth ?? 3,
				searchTruncated: relocated.budgetExhausted,
				relocationsTruncated: relocated.resultsTruncated,
			};
		};

		if (Array.isArray(cursor)) {
			if (segment === "length") {
				return miss("array-length-not-a-key",
					`\`length\` is a JavaScript array property, not a key in this data. The array has `
					+ `${cursor.length} element(s) — that count is already reported below.`);
			}
			if (!/^\d+$/.test(segment)) return miss("array-needs-index");
			const idx = Number(segment);
			if (idx >= cursor.length) return miss("index-out-of-range");
			cursor = cursor[idx];
			continue;
		}
		if (!isPlainObject(cursor)) return miss("not-a-container");
		if (!Object.hasOwn(cursor, segment)) return miss("no-such-key");
		cursor = cursor[segment];
	}
	return { ok: true, value: cursor, path: raw };
}

/** 0 iff the path resolved. Never 1: this module makes no claim about the repo, only about a path. */
export function exitCodeFor(result) {
	return result && result.ok === true ? 0 : 2;
}

/** The human-facing miss block. */
export function formatMiss(result, { query, subject } = {}) {
	const lines = [`testkit: NO SUCH PATH "${query ?? "(unknown)"}"${subject ? ` in ${subject}` : ""}.`];
	lines.push(`  resolved as far as:  ${result.stoppedAt}`);
	if (result.failedSegment !== null) lines.push(`  failed segment:      ${result.failedSegment}`);
	if (result.detail) lines.push(`  ${result.detail}`);

	const { container } = result;
	if (container.kind === "array") {
		lines.push(`  \`${result.stoppedAt}\` is an array of ${container.count}, not an object — index it, `
			+ `e.g. ${result.stoppedAt === "(root)" ? "0" : `${result.stoppedAt}.0`}.${result.failedSegment}`);
		if (container.keys.length) {
			lines.push(`  element keys (union over ${container.count})${container.keysTruncated ? ", truncated" : ""}: `
				+ container.keys.join(", "));
		}
	} else if (container.keys.length) {
		lines.push(`  keys available at ${result.stoppedAt}: ${container.keys.join(", ")} (${container.keys.length} total)`);
	}

	if (result.nearMisses.length === 1) {
		lines.push(`  the real key here:   ${result.nearMisses[0]}   <-- matches after case/underscore normalization`);
		lines.push(`  re-run with:  --field ${result.nearMisses[0]}`);
	} else if (result.nearMisses.length > 1) {
		lines.push("  SEVERAL keys here match after normalization — pick one deliberately, they are different fields:");
		for (const hit of result.nearMisses) lines.push(`    ${hit}`);
	} else if (result.relocations.length) {
		lines.push(`  no key here matches after case/underscore normalization.`);
		lines.push(`  found elsewhere (searched ${result.searchDepth} object levels below ${result.stoppedAt}):`);
		for (const hit of result.relocations) {
			lines.push(`    ${hit.path}${hit.note ? `   (${hit.note})` : ""}`);
		}
		if (result.relocations.length > 1) {
			lines.push("  MORE THAN ONE — these are different fields measuring different things. Not picking for you.");
		} else {
			lines.push(`  re-run with:  --field ${result.relocations[0].path}`);
		}
		if (result.relocationsTruncated) lines.push("  (more matches exist; list truncated)");
	} else {
		lines.push("  no key matches after case/underscore normalization, and no key of that name exists "
			+ `within ${result.searchDepth} object levels below ${result.stoppedAt}`
			+ (result.searchTruncated ? " (search hit its node budget — this is NOT a claim that it exists nowhere)" : "."));
		lines.push("  This is NOT a claim that the value is absent from the transfer — it is a claim that this");
		lines.push("  PATH does not exist in THIS record. Older records omit keys added later.");
	}
	return lines.join("\n");
}
