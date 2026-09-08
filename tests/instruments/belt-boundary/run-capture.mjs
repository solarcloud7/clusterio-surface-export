import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { lua, preflightState, assertLeaseClean } from "../../lab-gallery/batch-lifecycle.mjs";
import { withWorkflowLock } from "../../../tools/shared/workflow-lock.mjs";

const read = file => readFileSync(new URL(file, import.meta.url), "utf8");
const artifact = "ci-artifacts/belt-capture-result.json";
const array = value => Object.values(value || {});
const summarize = result => {
	const steps = result.steps.filter(step => step.sampled);
	const singles = steps.flatMap(step => array(step.single.rows));
	const halos = steps.flatMap(step => array(step.halo.rows));
	const total = rows => [...new Map(rows.map(row => [row.uid, row])).values()].reduce((n, row) => n + row.count, 0);
	return { case: result.case, order: result.order, batches: steps.length,
		plainCount: singles.reduce((n, row) => n + row.count, 0), deduplicatedCount: total(singles),
		neighborCount: total(halos), expected: 1,
		firstTick: steps[0]?.tick, lastTick: steps.at(-1)?.tick,
		status: total(halos) === 1 ? "PASS" : "STOP", clean: result.clean };
};
function analyze(result) {
	for (const run of result.runs.filter(run => run.steps?.length)) console.log(JSON.stringify(summarize(run)));
	console.log(JSON.stringify({ status: result.status, hash: result.hash, calls: result.calls,
		notTested: result.notTested, cleanup: result.cleanup, error: result.error }));
}
if (process.argv.includes("--analyze")) {
	analyze(JSON.parse(readFileSync(artifact, "utf8")));
} else {
	const fixtureText = read("capture-fixture.json"), fixture = JSON.parse(fixtureText), source = read("capture-probe.lua");
	const schema = JSON.parse(readFileSync("ci-artifacts/belt-boundary-api.json", "utf8"));
	assert.equal(schema.application_version, fixture.engine);
	const manifest = {
		LuaGameScript: ["create_surface", "delete_surface", "surfaces", "tick", "tick_paused", "connected_players"],
		LuaSurface: ["create_entity", "find_entity", "find_entities_filtered", "set_tiles", "request_to_generate_chunks", "force_generate_chunk_requests"],
		LuaEntity: ["valid", "type", "unit_number", "get_transport_line", "get_max_transport_line_index", "belt_neighbours", "underground_belt_neighbour"],
		LuaTransportLine: ["valid", "get_detailed_contents", "get_item_count", "insert_at_back", "line_length", "line_equals"],
		LuaItemStack: ["valid_for_read", "name", "count", "quality"], LuaQualityPrototype: ["name"],
		LuaBootstrap: ["active_mods"], LuaHelpers: ["json_to_table", "table_to_json", "create_profiler"], LuaProfiler: ["stop"],
	};
	for (const [name, members] of Object.entries(manifest)) {
		const cls = schema.classes.find(c => c.name === name); assert.ok(cls, name);
		const inherited = [];
		for (let current = cls; current; current = schema.classes.find(c => c.name === current.parent)) inherited.push(...current.methods, ...current.attributes);
		for (const member of members) assert.ok(inherited.some(m => m.name === member), `${name}.${member}`);
	}
	const detail = schema.concepts.find(c => c.name === "DetailedItemOnLine");
	assert.deepEqual(detail.type.parameters.map(p => [p.name, p.type]).sort(), [["position", "float"], ["stack", "LuaItemStack"], ["unique_id", "uint32"]]);
	const hash = createHash("sha256").update(source + fixtureText + read("capture-contract.md") + read("run-capture.mjs")).digest("hex");
	if (process.argv.includes("--prepare")) console.log(JSON.stringify({ hash, engine: fixture.engine, manifest, sourceBytes: Buffer.byteLength(source) }));
	else await withWorkflowLock(async () => {
		mkdirSync("ci-artifacts", { recursive: true });
		for (const host of [1, 2]) assertLeaseClean(host, preflightState(host), "before capture experiment");
		const foreign = lua(2, "local names={} for n in pairs(game.surfaces) do if type(n)=='string' and n:find('belt-capture-',1,true)==1 then names[#names+1]=n end end return {names=names,storage=storage.__belt_capture_experiment~=nil}");
		assert.deepEqual(array(foreign.names), []); assert.equal(foreign.storage, false);
		const started = Date.now(), token = `capture-${started}`;
		const result = { hash, engine: fixture.engine, manifest, status: "RUNNING", calls: 0, runs: [],
			notTested: ["production export/import", "multiple-item snapshot consistency", "stack merges/splits", "stateful items/spoilage", "loaders/linked belts", "performance improvement"] };
		const save = () => { const text = JSON.stringify(result, null, 2); assert.ok(Buffer.byteLength(text) < 8 * 1024 * 1024); writeFileSync(artifact, text); };
		let ownedName, ownedCase;
		const call = (mode, selected = "A", target = "A", rescue = false) => {
			if (!rescue) {
				assert.ok(result.calls < fixture.maxCalls, "RCON call bound exceeded");
				assert.ok(Date.now() - started < fixture.maxRuntimeMs, "runtime bound exceeded");
			}
			result.calls++;
			const code = source.replace("__FIXTURE__", fixtureText).replaceAll("__TOKEN__", token)
				.replaceAll("__NAME__", ownedName).replaceAll("__CASE__", ownedCase)
				.replaceAll("__MODE__", mode).replaceAll("__SELECTED__", selected).replaceAll("__TARGET__", target);
			assert.ok(Buffer.byteLength(code) < 16 * 1024);
			const out = lua(2, code); assert.ok(Buffer.byteLength(JSON.stringify(out)) < 128 * 1024);
			return out;
		};
		const checked = (...args) => {
			const out = call(...args);
			assert.notEqual(out.status, "HARNESS_ERROR", out.error); assert.ok(!out.error, out.error);
			return out;
		};
		const clean = () => {
			const out = call("cleanup", "A", "A", true);
			// Factorio may defer deletion until this callback returns; the next read owns the verdict.
			assert.equal(out.storageAbsent, true); assert.equal(out.paused, false);
			const independent = lua(2, `return {surfaceAbsent=game.surfaces['${ownedName}']==nil,storageAbsent=storage.__belt_capture_experiment==nil,paused=game.tick_paused}`);
			assert.deepEqual(independent, {surfaceAbsent:true,storageAbsent:true,paused:false});
			ownedName = null;
			return independent;
		};
		try {
			ownedName = `belt-capture-${started}-cleanup`; ownedCase = "smoke";
			const injected = call("inject"); assert.equal(injected.status, "HARNESS_ERROR");
			assert.match(injected.error, /injected construction failure/); assert.equal(injected.cleanup.storageAbsent, true);
			result.runs.push({ case: "injected-failure", result: injected, clean: clean() }); save();
			ownedName = `belt-capture-${started}-smoke`; ownedCase = "smoke";
			result.mods = checked("setup").mods;
			const smoke = checked("smoke"); assert.equal(smoke.physical.total, 0);
			assert.ok(array(smoke.shape).every(row => row.selfEquals));
			assert.equal(array(smoke.shape).length, 5);
			result.runs.push({ case: "shape-smoke", result: smoke, clean: clean() }); save();
			const arms = [
				{ case: "straight", order: "upstream-first", seed: "A", sequence: [["A", "A"], ["B", "B"]] },
				{ case: "straight", order: "downstream-first", seed: "A", sequence: [["B", "A"], ["A", "B"]] },
				{ case: "splitter", order: "upstream-first", seed: "A", sequence: [["A", "A"], ["B", "C,D"], ["C", "C,D"], ["D", "C,D"]] },
				{ case: "loop", order: "item outside one-hop window", seed: "C", sequence: [["A", "C"], ["B", "D"], ["C", "A"], ["D", "B"]] },
			];
			for (const arm of arms) {
				ownedName = `belt-capture-${started}-${result.runs.length}`; ownedCase = arm.case;
				assert.deepEqual(checked("setup").mods, result.mods);
				const run = { case: arm.case, order: arm.order, steps: [] }; result.runs.push(run);
				run.shape = checked("smoke").shape;
				run.steps.push(checked("seed", arm.sequence[0][0], arm.seed)); save();
				for (const [selected, target] of arm.sequence.slice(1)) {
					let sampled = false;
					for (let attempt = 0; attempt < fixture.maxPollsPerStep; attempt++) {
						const out = checked("sample", selected, target);
						run.steps.push(out); save();
						if (out.sampled) { sampled = true; break; }
					}
					assert.ok(sampled, `Requested movement/window not observed: ${arm.case}/${selected}/${target}`);
				}
				run.clean = clean();
				run.summary = summarize(run); save(); console.log(JSON.stringify(run.summary));
				if (run.summary.status === "STOP") { result.status = "STOP"; break; }
			}
			if (result.status === "RUNNING") result.status = "PASS";
		} catch (error) { result.status = "HARNESS_ERROR"; result.error = error.message; throw error; }
		finally {
			try {
				if (ownedName) clean();
				result.cleanup = {};
				for (const host of [1, 2]) { const state = preflightState(host); result.cleanup[host] = state; assertLeaseClean(host, state, "after capture experiment"); }
			} catch (error) { result.status = "HARNESS_ERROR"; result.error = `Cleanup: ${error.message}`; throw error; }
			finally { result.elapsedMs = Date.now() - started; save(); }
		}
		analyze(result);
	});
}
