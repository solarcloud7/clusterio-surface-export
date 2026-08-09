export function normalizeKey(key) {
	return String(key).toLowerCase().replace(/_/g, "");
}

const isPlainObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

function joinPath(...parts) {
	return parts.filter(part => part !== "" && part !== null && part !== undefined).join(".");
}

const ELEMENT_KEY_CAP = 200;

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
			const hitIndices = [];
			for (const [index, element] of node.entries()) {
				if (isPlainObject(element) && Object.keys(element).some(k => normalizeKey(k) === wanted)) {
					hitIndices.push(index);
				}
			}
			if (hitIndices.length) {
				const key = Object.keys(node[hitIndices[0]]).find(k => normalizeKey(k) === wanted);
				found.push({
					path: joinPath(prefix, hitIndices[0], key),
					note: `present on ${hitIndices.length} of ${node.length} elements`,
				});
				if (found.length >= maxResults) { resultsTruncated = true; return; }
			}
			for (const [index, element] of node.entries()) {
				if (isPlainObject(element) || Array.isArray(element)) walk(element, joinPath(prefix, index), depth);
			}
			return;
		}

		if (!isPlainObject(node) || depth >= maxDepth) return;
		for (const [key, value] of Object.entries(node)) {
			const path = joinPath(prefix, key);
			if (depth >= 1 && normalizeKey(key) === wanted) {
				found.push({ path, note: null });
				if (found.length >= maxResults) { resultsTruncated = true; return; }
			}
			if (isPlainObject(value) || Array.isArray(value)) walk(value, path, depth + 1);
		}
	};

	walk(root, "", 0);
	const seen = new Set();
	const unique = found.filter(hit => !seen.has(hit.path) && seen.add(hit.path));
	return { hits: unique, budgetExhausted, resultsTruncated };
}

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
			const nearMisses = container.kind === "object"
				? container.keys.filter(key => normalizeKey(key) === wanted)
					.map(key => joinPath(stoppedAt === "(root)" ? "" : stoppedAt, key))
				: [];
			const relocated = nearMisses.length
				? { hits: [], budgetExhausted: false, resultsTruncated: false }
				: relocate(cursor, segment, options);
			const prefix = stoppedAt === "(root)" ? "" : stoppedAt;
			return {
				ok: false, reason, stoppedAt, failedSegment: segment, container, detail,
				nearMisses,
				relocations: relocated.hits.map(hit => ({ ...hit, path: joinPath(prefix, hit.path) })),
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

export function exitCodeFor(result) {
	return result && result.ok === true ? 0 : 2;
}

export function formatMiss(result, { query, subject } = {}) {
	const lines = [`testkit: NO SUCH PATH "${query ?? "(unknown)"}"${subject ? ` in ${subject}` : ""}.`];
	lines.push(`  resolved as far as:  ${result.stoppedAt}`);
	if (result.failedSegment !== null) lines.push(`  failed segment:      ${result.failedSegment}`);
	if (result.detail) lines.push(`  ${result.detail}`);

	const { container } = result;
	if (container.kind === "array") {
		lines.push(`  \`${result.stoppedAt}\` is an array of ${container.count}, not an object — index it`
			+ (result.relocations.length ? "; the element(s) carrying that key are listed below" : `, `
				+ `e.g. ${joinPath(result.stoppedAt === "(root)" ? "" : result.stoppedAt, 0, result.failedSegment)}`));
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
