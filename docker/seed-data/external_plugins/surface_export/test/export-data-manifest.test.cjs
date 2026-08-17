"use strict";

// export-data-manifest.test — the exportData envelope's keys, pinned on both sides of the boundary
//
// requires: messages.ts (the ExportData declaration) and module/core/export-pipeline.lua (the
//           envelope ExportCache.record writes)
// produces: a two-direction check of the committed MANIFEST against each real source — the declared
//           keys parsed out of messages.ts, and the envelope keys parsed out of export-pipeline.lua
//           — plus a positive check that each TS-origin key is written somewhere in the plugin's TS
// does not: cover what messages.roundtrip.test.cjs already covers (that harness discovers every
//           message class and checks jsonSchema/toJSON/fromJSON agreement, but every class carries
//           the payload as `exportData: { type: "object" }`, so no key INSIDE it is ever seen);
//           read the inner payload (job.export_data's own top-level keys ride inside the
//           deflate-encoded `payload` string on the compressed path and reach no TS declaration);
//           scan the TS side for keys written onto an export-data object that the manifest omits;
//           or claim a manifest key is READ anywhere

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pluginRoot = path.join(__dirname, "..");
const messagesSource = fs.readFileSync(path.join(pluginRoot, "messages.ts"), "utf8");
const exportPipelineSource = fs.readFileSync(
	path.join(pluginRoot, "module", "core", "export-pipeline.lua"), "utf8");
const tsSources = ["controller.ts", "instance.ts", "helpers.ts", path.join("lib", "transfer-orchestrator.ts")]
	.map(rel => fs.readFileSync(path.join(pluginRoot, rel), "utf8"))
	.join("\n");

const LUA_ENVELOPE = "lua_envelope";
const LUA_INNER = "lua_inner";
const TS_INJECTED = "ts_injected";

const MANIFEST = [
	{ name: "compressed", declared: true, origin: LUA_ENVELOPE },
	{ name: "compression", declared: true, origin: LUA_ENVELOPE },
	{ name: "payload", declared: true, origin: LUA_ENVELOPE },
	{ name: "platform_name", declared: true, origin: LUA_ENVELOPE },
	{ name: "stats", declared: true, origin: LUA_ENVELOPE },
	{ name: "verification", declared: true, origin: LUA_ENVELOPE },
	{
		name: "tick",
		declared: false,
		origin: LUA_ENVELOPE,
		note: "written into the envelope at export-pipeline.lua:397 and into the inner payload at :221; "
			+ "ExportData declares no key of this name",
	},
	{
		name: "timestamp",
		declared: false,
		origin: LUA_ENVELOPE,
		note: "written into the envelope at export-pipeline.lua:398 and into the inner payload at :222; "
			+ "ExportData declares no key of this name",
	},
	{
		name: "platform",
		declared: true,
		origin: LUA_INNER,
		note: "written into the inner payload at export-pipeline.lua:223; the compressed branch "
			+ "(:391-401) does not copy it onto the envelope, and lib/transfer-orchestrator.ts:114 reads "
			+ "it off the object it calls innerData",
	},
	{
		name: "_transferId",
		declared: true,
		origin: TS_INJECTED,
		note: "written at lib/transfer-orchestrator.ts:186 and read at instance.ts:532 and at "
			+ "module/core/import-pipeline.lua:86,320 — TS to Lua, the reverse of the export direction",
	},
	{
		name: "_sourceInstanceId",
		declared: true,
		origin: TS_INJECTED,
		note: "written at lib/transfer-orchestrator.ts:186 and read at instance.ts:536 and at "
			+ "module/core/import-pipeline.lua:321",
	},
	{
		name: "_operationId",
		declared: true,
		origin: TS_INJECTED,
		note: "written at controller.ts:330 and read at module/core/import-pipeline.lua:322",
	},
];

function matchedBlock(source, openIndex) {
	let depth = 0;
	for (let i = openIndex; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}") {
			depth--;
			if (depth === 0) return source.slice(openIndex, i + 1);
		}
	}
	throw new Error("unbalanced braces — the scan desynced rather than reaching a closing brace");
}

function exportDataBlock(source) {
	const marker = "export type ExportData = {";
	const start = source.indexOf(marker);
	assert.notEqual(start, -1, "ExportData is not declared in messages.ts under that name");
	return matchedBlock(source, start + marker.length - 1);
}

function declaredKeys(source) {
	const body = exportDataBlock(source);
	return [...body.matchAll(/^\t([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map(m => m[1]).sort();
}

function luaTableKeys(table) {
	const body = table.slice(1, -1);
	const keys = [];
	let depth = 0;
	let start = 0;
	const take = end => {
		const key = body.slice(start, end).match(/^\s*([a-z_][a-z0-9_]*)\s*=(?!=)/);
		if (key) keys.push(key[1]);
	};
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (ch === "{" || ch === "(") depth++;
		else if (ch === "}" || ch === ")") depth--;
		else if ((ch === "," || ch === ";") && depth === 0) { take(i); start = i + 1; }
	}
	take(body.length);
	return keys;
}

function envelopeKeys(source) {
	const marker = "ExportCache.record(export_id, {";
	const start = source.indexOf(marker);
	assert.notEqual(start, -1,
		"export-pipeline.lua no longer builds the envelope with an inline table at ExportCache.record — "
		+ "the key list this test reads is gone, and an empty list would agree with an empty manifest");
	return luaTableKeys(matchedBlock(source, start + marker.length - 1)).sort();
}

const manifestNames = MANIFEST.map(row => row.name);

test("the manifest is a list, not a shape: every row names one key exactly once", () => {
	assert.ok(MANIFEST.length >= 10, `manifest carries ${MANIFEST.length} rows`);
	assert.deepEqual([...new Set(manifestNames)].sort(), [...manifestNames].sort());
	for (const row of MANIFEST) {
		assert.ok([LUA_ENVELOPE, LUA_INNER, TS_INJECTED].includes(row.origin), `${row.name}.origin`);
		if (row.declared && row.origin === LUA_ENVELOPE) continue;
		assert.equal(typeof row.note, "string", `${row.name} is one-sided and carries no note`);
		assert.notEqual(row.note.trim(), "",
			`${row.name} is one-sided and its note is blank — nothing mechanical reads the note, so the `
			+ "only thing keeping it honest is that a one-sided row cannot exist without one");
	}
});

test("the gap this fills: the payload rides as an opaque object in every message schema", () => {
	const schemas = [];
	const marker = "exportData: {";
	for (let at = messagesSource.indexOf(marker); at !== -1; at = messagesSource.indexOf(marker, at + 1)) {
		schemas.push(matchedBlock(messagesSource, at + marker.length - 1));
	}
	assert.ok(schemas.length >= 3,
		`only ${schemas.length} exportData schema declarations found — the premise of this test is that `
		+ "several message classes carry the payload");
	for (const schema of schemas) {
		assert.equal(/\bproperties\s*:/.test(schema), false,
			`a message class declares exportData as ${schema} — once it carries its own properties, `
			+ "messages.roundtrip.test.cjs checks toJSON against them and this manifest is the second copy");
		assert.match(schema, /type\s*:\s*"object"/);
	}
});

test("the ExportData declaration is open, which is why tsc cannot see a drift here", () => {
	assert.match(exportDataBlock(messagesSource), /\[\s*[A-Za-z_][A-Za-z0-9_]*\s*:\s*string\s*\]\s*:/,
		"ExportData carries an index signature today; without one tsc rejects an undeclared key at every "
		+ "write site and this manifest is checking something the compiler already checks");
});

test("MANIFEST vs messages.ts: the declared keys agree in both directions", () => {
	const declared = declaredKeys(messagesSource);
	assert.ok(declared.length >= 8, `parsed ${declared.length} declared keys`);
	assert.deepEqual(declared, MANIFEST.filter(row => row.declared).map(row => row.name).sort(),
		"a key declared on ExportData with no manifest row, or a manifest row claiming a declaration that "
		+ "is gone, is exactly the drift the index signature hides from tsc");
});

test("MANIFEST vs export-pipeline.lua: the envelope keys agree in both directions", () => {
	const envelope = envelopeKeys(exportPipelineSource);
	assert.ok(envelope.length >= 6, `parsed ${envelope.length} envelope keys`);
	assert.deepEqual(envelope, MANIFEST.filter(row => row.origin === LUA_ENVELOPE)
		.map(row => row.name).sort(),
	"the Lua envelope is the only thing that puts a key on the wire from the export side: a key it "
		+ "starts writing that nothing declares, and a key it stops writing that TS still declares, are "
		+ "both silent today");
});

test("each TS-injected key is written by the plugin's own TypeScript", () => {
	const injected = MANIFEST.filter(row => row.origin === TS_INJECTED);
	assert.ok(injected.length > 0, "there must be TS-origin rows, or this test proves nothing");
	for (const row of injected) {
		assert.match(tsSources, new RegExp(`${row.name}\\s*[:=]`),
			`${row.name} is manifested as written by TS, and no write of it appears in the scanned TS`);
	}
});

test("MUTATION KILL: an envelope key the manifest omits is reported", () => {
	const mutated = exportPipelineSource.replace("\t\t\tcompression = \"deflate\",",
		"\t\t\tcompression = \"deflate\",\n\t\t\tcensus_verdict = job.census_verdict,");
	assert.notEqual(mutated, exportPipelineSource, "the mutation must apply, or this test proves nothing");
	const envelope = envelopeKeys(mutated);
	assert.ok(envelope.includes("census_verdict"), "the scan must SEE the added envelope key");
	assert.notDeepEqual(envelope, MANIFEST.filter(row => row.origin === LUA_ENVELOPE)
		.map(row => row.name).sort());
});

test("MUTATION KILL: a declaration removed from ExportData is reported", () => {
	const mutated = messagesSource.replace("\t_operationId?: string;\n", "");
	assert.notEqual(mutated, messagesSource, "the mutation must apply, or this test proves nothing");
	const declared = declaredKeys(mutated);
	assert.equal(declared.includes("_operationId"), false, "the scan must SEE the removed declaration");
	assert.notDeepEqual(declared, MANIFEST.filter(row => row.declared).map(row => row.name).sort());
});

test("MUTATION KILL: a desynced brace scan raises instead of returning a short read", () => {
	assert.throws(() => matchedBlock("{ a: 1, b: { c: 2 }", 0), /unbalanced braces/);
	assert.equal(matchedBlock("{ a: 1, b: { c: 2 } } tail", 0), "{ a: 1, b: { c: 2 } }");
	assert.deepEqual(luaTableKeys("{ a = 1, b = { c = 2, d = 3 }, e = f(g, h) }"), ["a", "b", "e"]);
	assert.deepEqual(luaTableKeys("{ a = 1; b = 2 }"), ["a", "b"],
		"Lua separates table elements with `;` as readily as with `,`, and a scan that reads only commas "
		+ "returns a SHORT key list, which the both-directions check then reports as a manifest drift");
});
