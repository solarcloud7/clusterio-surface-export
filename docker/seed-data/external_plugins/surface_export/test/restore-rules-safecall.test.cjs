"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const deserializerPath = path.join(__dirname, "..", "module", "core", "deserializer.lua");
const source = fs.readFileSync(deserializerPath, "utf8");

function extractRules() {
	const marker = "local SIMPLE_RESTORE_RULES = {";
	const start = source.indexOf(marker);
	assert.notEqual(start, -1, "SIMPLE_RESTORE_RULES must exist in deserializer.lua");
	let depth = 0;
	let end = -1;
	for (let i = start + marker.length - 1; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}") {
			depth--;
			if (depth === 0) { end = i; break; }
		}
	}
	assert.notEqual(end, -1, "SIMPLE_RESTORE_RULES must be a closed table");
	const body = source.slice(start + marker.length, end);

	const rules = [];
	let rowDepth = 0;
	let rowStart = -1;
	for (let i = 0; i < body.length; i++) {
		if (body[i] === "{") {
			if (rowDepth === 0) rowStart = i;
			rowDepth++;
		} else if (body[i] === "}") {
			rowDepth--;
			if (rowDepth === 0) rules.push(body.slice(rowStart, i + 1));
		}
	}
	return rules;
}

const rules = extractRules();

const fieldOf = rule => (rule.match(/field\s*=\s*"([^"]+)"/) || [])[1];

const TYPE_BRANCH_START = "if entity.type == \"entity-ghost\" then";
const TYPE_BRANCH_END = "local IS_CRAFTER";
const TYPE_BRANCH_MARKERS = ["tile-ghost", "display-panel", "item-request-proxy"];
const TYPE_BRANCH_WRITE_CONTROLS = ["insert_plan", "display_panel_text", "records"];
const MIN_TYPE_BRANCH_WRITES = 4;

function onlyIndexOf(marker) {
	const start = source.indexOf(marker);
	assert.notEqual(start, -1, `the type-branch region marker "${marker}" must exist in deserializer.lua`);
	assert.equal(source.lastIndexOf(marker), start,
		`the type-branch region marker "${marker}" must be unique — a duplicate silently shrinks the `
		+ "scanned region, and a region of nothing has no offenders");
	return start;
}

function typeBranchRegion() {
	const start = onlyIndexOf(TYPE_BRANCH_START);
	const end = onlyIndexOf(TYPE_BRANCH_END);
	assert.ok(end > start, "the type-branch region must end after it begins");
	const region = source.slice(start, end);
	for (const marker of TYPE_BRANCH_MARKERS) {
		assert.ok(region.includes(marker), `the type-branch region must still cover the ${marker} branch`);
	}
	return region;
}

function closingParen(region, openIndex) {
	let depth = 0;
	let quote = null;
	for (let i = openIndex; i < region.length; i++) {
		const ch = region[i];
		if (quote) {
			if (ch === "\\") i++;
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === "\"" || ch === "'") { quote = ch; continue; }
		if (ch === "-" && region[i + 1] === "-") {
			const newline = region.indexOf("\n", i);
			if (newline === -1) break;
			i = newline;
			continue;
		}
		if (ch === "(") depth++;
		else if (ch === ")" && --depth === 0) return i;
	}
	throw new Error(`a safe_call( in the type-branch region never closes at offset ${openIndex} — the `
		+ "paren lexer desynced, and a desynced lexer must fail loud rather than report a merged span "
		+ "that swallows every write");
}

function safeCallSpans(region) {
	const spans = [];
	for (let at = region.indexOf("safe_call("); at !== -1; at = region.indexOf("safe_call(", at + 1)) {
		const open = at + "safe_call".length;
		spans.push([open, closingParen(region, open)]);
	}
	return spans;
}

function entityWrites(region) {
	const patterns = [
		/\bentity\.([a-z_][a-z0-9_]*)\s*=(?!=)/g,
		/\bentity\.(?:[a-z_][a-z0-9_]*\([^()]*\)\.)+([a-z_][a-z0-9_]*)\s*=(?!=)/g,
		/\bentity\.(?:[a-z_][a-z0-9_]*\.)+([a-z_][a-z0-9_]*)\s*=(?!=)/g,
		/\bentity\[([^\]]+)\]\s*=(?!=)/g,
	];
	const byIndex = new Map();
	for (const pattern of patterns) {
		for (const match of region.matchAll(pattern)) {
			if (!byIndex.has(match.index)) byIndex.set(match.index, { property: match[1], index: match.index });
		}
	}
	return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

function unguardedWrites(region) {
	const spans = safeCallSpans(region);
	const guarded = write => spans.some(([open, close]) => write.index > open && write.index < close);
	return entityWrites(region).filter(write => !guarded(write)).map(write => write.property);
}

test("the rule table parses into plausible rows (a broken parser must not pass vacuously)", () => {
	assert.ok(rules.length >= 20, `expected the rule table to carry many rows, parsed ${rules.length}`);
	const named = rules.filter(rule => fieldOf(rule) !== undefined);
	assert.equal(named.length, rules.length, "every parsed row must carry a field name");
	const typesGated = rules.filter(rule => /\btypes\s*=/.test(rule));
	assert.ok(typesGated.length >= 10,
		`expected many types-gated rows, parsed ${typesGated.length} — the types detection is broken`);
});

test("every types-gated restore rule carries safecall", () => {
	const offenders = rules
		.filter(rule => /\btypes\s*=/.test(rule))
		.filter(rule => !/\bsafecall\s*=\s*true\b/.test(rule))
		.map(fieldOf);
	assert.deepEqual(offenders, [],
		"a types-gated row skips the read-probe that incidentally guards probe-matched rows, so its write "
		+ "reaches the entity unguarded on the on_tick import path — where a throw kills the instance. "
		+ "Add safecall = true to: " + offenders.join(", "));
});

test("the type-branch scan sees its own writes and spans (a broken scanner must not pass vacuously)", () => {
	const region = typeBranchRegion();
	const writes = entityWrites(region);
	const spans = safeCallSpans(region);

	assert.ok(writes.length >= MIN_TYPE_BRANCH_WRITES,
		`the type-branch region yielded ${writes.length} entity writes, floor is ${MIN_TYPE_BRANCH_WRITES}`);
	const properties = new Set(writes.map(write => write.property));
	for (const control of TYPE_BRANCH_WRITE_CONTROLS) {
		assert.ok(properties.has(control),
			`the write detector lost the known type-branch write entity.${control} — it is scanning the `
			+ "wrong region or the write pattern drifted");
	}
	assert.equal(spans.length, region.split("safe_call(").length - 1,
		"every safe_call( in the region must yield exactly one span: a matcher that collapses them into "
		+ "one range covering the whole region leaves every bare write reading guarded");
	assert.deepEqual(spans.filter(([open, close]) => region[open] !== "(" || region[close] !== ")"), [],
		"every span must be delimited by the parens of its own safe_call( — a matcher that keeps the span "
		+ "COUNT honest while widening each span to the whole region passes the count check above and "
		+ "still swallows every bare write");
	const ordered = [...spans].sort((a, b) => a[0] - b[0]);
	assert.deepEqual(ordered.filter(([open], index) => index > 0 && open <= ordered[index - 1][1]), [],
		"safe_call spans must not overlap: overlap means the matcher widened a span past its own closing "
		+ "paren. A genuinely nested safe_call would also land here — it would need this control revisited "
		+ "rather than deleted");
});

test("every entity write in the deserializer type branches is inside safe_call", () => {
	const offenders = unguardedWrites(typeBranchRegion());
	assert.deepEqual(offenders, [],
		"a type-branch write reaches the entity unguarded on the on_tick import path (control.lua on_tick "
		+ "-> AsyncProcessor.process_tick -> entity_creation.lua -> restore_entity_state), and that chain "
		+ "contains no pcall, so a throw there kills the instance. These branches sit outside "
		+ "SIMPLE_RESTORE_RULES, so no rule-row check reaches them. Wrap in safe_call: "
		+ offenders.join(", "));
});

test("MUTATION KILL: a bare nested-chain write in the region is an offender", () => {
	const region = typeBranchRegion();
	assert.deepEqual(unguardedWrites(`${region}\n    entity.burner.currently_burning = data.fuel\n`),
		["currently_burning"],
		"entity.a.b = is the shape the two original patterns could not see: the first needs `=` right "
		+ "after the first name, the second needs a call in the chain. The deserializer performs three such "
		+ "writes today (train.schedule, burner.currently_burning, burner.remaining_burning_fuel), all "
		+ "outside this region — so nothing but this injection can prove the arm reads the shape at all");
	assert.deepEqual(unguardedWrites(`${region}\n    safe_call("x", function() entity.burner.f = 1 end)\n`),
		[], "and the arm must still respect safe_call, or it would report every guarded write as an offender");
});

test("MUTATION KILL: a bare bracket-index write in the region is an offender", () => {
	const region = typeBranchRegion();
	assert.deepEqual(unguardedWrites(`${region}\n    entity[hub_field] = data[hub_field]\n`), ["hub_field"],
		"a bracket write reaches the entity exactly as a dotted one does, and the guard cares about the "
		+ "throw, not about whether the property name is statically known");
	assert.deepEqual(unguardedWrites(`${region}\n    safe_call("x", function() entity[f] = 1 end)\n`), [],
		"and a guarded bracket write is not an offender");
});

test("the four write patterns never double-count one write site", () => {
	const writes = entityWrites('entity.health = 1\nentity.train.schedule = 2\n'
		+ 'entity.get_inventory(1).bar = 3\nentity[prop] = 4\n');
	assert.deepEqual(writes.map(write => write.property), ["health", "schedule", "bar", "prop"],
		"each site must yield exactly one write: a site counted twice inflates the floor above and could "
		+ "carry the region past MIN_TYPE_BRANCH_WRITES while real writes went missing");
});

test("override_logistic_mode is restored before the saved_* rows it would otherwise consume", () => {
	const order = rules.map(fieldOf);
	const override = order.indexOf("override_logistic_mode");
	assert.notEqual(override, -1, "override_logistic_mode must be a restore rule");
	for (const saved of ["saved_request_filters", "saved_storage_filters",
		"saved_request_from_buffers", "saved_set_requests"]) {
		const index = order.indexOf(saved);
		assert.notEqual(index, -1, `${saved} must be a restore rule`);
		assert.ok(override < index,
			`${saved} must be restored AFTER override_logistic_mode: writing the override applies the saved `
			+ "requests into the now-live logistic point, which clears the saved table (measured 2.1.11), and "
			+ "the reverse order additionally trips an engine assertion on the destination");
	}
});

test("result_quality is restored after crafting_progress, which is what makes it writable", () => {
	const order = rules.map(fieldOf);
	const progress = order.indexOf("crafting_progress");
	const quality = order.indexOf("result_quality");
	assert.notEqual(progress, -1, "crafting_progress must be a restore rule");
	assert.notEqual(quality, -1, "result_quality must be a restore rule");
	assert.ok(progress < quality,
		"result_quality reads nil unless a craft is in progress, so writing it before crafting_progress is "
		+ "a silent no-op (measured 2.1.11)");
});
