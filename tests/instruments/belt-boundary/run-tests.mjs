import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { lua, preflightState, assertLeaseClean } from "../../lab-gallery/batch-lifecycle.mjs";
import { withWorkflowLock } from "../../../tools/shared/workflow-lock.mjs";
const read = name => readFileSync(new URL(name, import.meta.url), "utf8");
const candidate = process.argv.includes("--candidate");
const artifact = candidate ? "ci-artifacts/belt-boundary-force-result.json" : "ci-artifacts/belt-boundary-result.json";
const analyze = results => {
	for (const run of results.runs) {
		const steps = Object.values(run.result.steps || {});
		console.log(JSON.stringify({ mode: run.mode, status: run.result.status, clean: run.result.clean,
			cause: run.result.cause, steps: steps.length, last: steps.at(-1) }));
	}
};
if (process.argv.includes("--analyze")) {
	analyze(JSON.parse(readFileSync(artifact, "utf8")));
} else await withWorkflowLock(async () => {
	const fixture = JSON.parse(read("fixture.json")), source = read("probe.lua");
	const schema = JSON.parse(readFileSync("ci-artifacts/belt-boundary-api.json", "utf8"));
	assert.equal(schema.application_version, fixture.engine);
	const manifest = { LuaGameScript: ["create_surface", "delete_surface", "surfaces", "tick"],
		LuaSurface: ["create_entity", "find_entity", "set_tiles", "request_to_generate_chunks", "force_generate_chunk_requests", "valid"],
		LuaEntity: ["valid", "type", "disabled_by_script", "get_transport_line", "prototype"], LuaEntityPrototype: ["belt_speed"],
		LuaTransportLine: ["get_detailed_contents", "line_length", "line_equals", "can_insert_at", "insert_at", "force_insert_at"],
		LuaItemStack: ["valid_for_read", "name", "count", "quality"], LuaQualityPrototype: ["name"], LuaBootstrap: ["active_mods"], LuaHelpers: ["json_to_table"] };
	for (const [name, members] of Object.entries(manifest)) {
		const cls = schema.classes.find(c => c.name === name); assert.ok(cls, name);
		const inherited = [];
		for (let current = cls; current; current = schema.classes.find(c => c.name === current.parent)) {
			inherited.push(...current.methods, ...current.attributes);
		}
		for (const name of members) assert.ok(inherited.find(m => m.name === name), `${cls.name}.${name}`);
	}
	assert.ok(schema.classes.find(c => c.name === "LuaEntity").attributes.find(a => a.name === "disabled_by_script").write_type, "disabled_by_script must be writable at this pin");
	const results = { hash: createHash("sha256").update(source + read("fixture.json") + readFileSync(fileURLToPath(import.meta.url))).digest("hex"), engine: fixture.engine, manifest, runs: [] };
	for (const host of [1, 2]) assertLeaseClean(host, preflightState(host), "before boundary probe");
	const leftovers = lua(2, `local names={} for n in pairs(game.surfaces) do if type(n)=="string" and string.find(n,"belt-boundary-",1,true)==1 then names[#names+1]=n end end return {names=names}`);
	assert.deepEqual(Object.values(leftovers.names), []);
	try {
		for (const mode of candidate ? ["cleanup", "smoke", "baseline", "baseline", "baseline", "force"] : ["cleanup", "smoke", "baseline"]) {
			const name = `belt-boundary-${Date.now()}-${mode}`;
			const body = source.replace("__FIXTURE__", JSON.stringify(fixture)).replaceAll("__NAME__", name).replaceAll("__MODE__", mode);
			assert.ok(Buffer.byteLength(body) < 16 * 1024);
			let result;
			try {
				if (mode !== "cleanup") {
					const setup = lua(2, source.replace("__FIXTURE__", JSON.stringify(fixture)).replaceAll("__NAME__", name).replaceAll("__MODE__", "setup"));
					assert.equal(setup.prepared, true, setup.error);
				}
				result = lua(2, body);
			}
			finally {
				const cleanup = lua(2, `local s=game.surfaces["${name}"];local leaked=s~=nil;if s then game.delete_surface(s) end return {clean=game.surfaces["${name}"]==nil,leaked=leaked}`);
				assert.equal(cleanup.clean, true); assert.equal(cleanup.leaked, false, "Lua cleanup must succeed without runner repair");
				if (result) result.clean = cleanup.clean && !cleanup.leaked;
			}
			assert.ok(Buffer.byteLength(JSON.stringify(result)) < 128 * 1024);
			results.runs.push({ mode, result });
			writeFileSync(artifact, JSON.stringify(results, null, 2));
			assert.notEqual(result.status, "HARNESS_ERROR", result.error);
			assert.equal(result.clean, true);
			if (candidate && mode === "baseline") {
				assert.equal(result.cause, "successful insertion crossed side group", "baseline must reproduce before judging the candidate");
				const steps = Object.values(result.steps), last = steps.at(-1);
				assert.equal(steps.length, 13);
				assert.equal(last.id, 50106); assert.equal(last.line, 2); assert.equal(last.sourceK, 246);
				assert.equal(last.requestedK, 214); assert.equal(last.inserted, true);
				assert.deepEqual(last.before, [48, 0]); assert.deepEqual(last.after, [48, 4]);
				assert.equal(result.startTick, result.endTick);
				assert.ok(Object.values(result.shape).every(row => row.same), "fixture must have settled internal segments");
				continue;
			}
			if (mode === "force" && result.status === "PASS") {
				const expected = fixture.groups.flatMap(g => g.slots.map((s, i) => ({
					id: g.item_source_positions[i*3], line: g.item_source_positions[i*3+1], k: g.item_source_positions[i*3+2],
					n: s.n, ct: s.ct, q: s.q || "normal",
				})));
				const actual = Object.values(result.steps).at(-1).physical.rows.map(({ uid, ...row }) => row);
				const keys = rows => rows.map(r => `${r.id}/${r.line}/${r.k}/${r.n}/${r.q}/${r.ct}`).sort();
				result.exactCapturedStacks = JSON.stringify(keys(actual)) === JSON.stringify(keys(expected));
				if (!result.exactCapturedStacks) { result.status = "STOP"; result.cause = "captured stack positions or contents differ"; }
				writeFileSync(artifact, JSON.stringify(results, null, 2));
			}
			if (result.status === "STOP") break;
		}
	} finally {
		for (const host of [1, 2]) assertLeaseClean(host, preflightState(host), "after boundary probe");
	}
	analyze(results);
});
