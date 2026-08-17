// capture-join.test — a captured field has a consumer, and a consumed field has a producer
//
// requires: we-set.json committed beside derive-we-set.mjs, capture-join-accounted.json, and the
//           module Lua both were read from
// produces: the join re-run against live module source, its floors and known-site controls, the two
//           ledger directions, and mutation-kill evidence for each: a reconstructed historical dead
//           field turns direction A red, a synthetic unproduced read turns direction B red, and
//           removing any single arm (restore rules, the goto-containing scopes, the alias-parameter
//           hop, the scoped root) turns a NAMED control red
// does not: contact the cluster, claim a consumed field is restored (a read is a read), or cover the
//           control_behavior, item-stack or top-level payload planes

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	DESERIALIZER_REL, HANDLERS_REL, SCOPED_ROOT_CONTROLS, assemble, checkJoinControls, loadSources,
} from "./derive-we-set.mjs";
import { analyzeJoin, joinKey, scanPayloadTouches, declaredFunctions } from "./capture-join.mjs";
import { loadWeSet } from "./we-set.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const LEDGER_PATH = path.join(here, "capture-join-accounted.json");
const LIVE_LEDGER = JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
const EMPTY_LEDGER = { captured_without_consumer: [], consumed_without_producer: [] };

const sources = loadSources();
const sourceOf = rel => [...sources.captureFiles, ...sources.restoreFiles]
	.find(file => file.rel === rel).source;
const artifact = loadWeSet();

const ACTIVE_STATE_REL = "import_phases/active_state_restoration.lua";
const LATCH_REL = "import_phases/latch_rearm.lua";

function substitute(overrides) {
	const pending = new Set(Object.keys(overrides));
	const patch = files => files.map(file => {
		if (!pending.has(file.rel)) return file;
		pending.delete(file.rel);
		return { rel: file.rel, source: overrides[file.rel] };
	});
	const patched = { captureFiles: patch(sources.captureFiles), restoreFiles: patch(sources.restoreFiles) };
	assert.deepEqual([...pending], [],
		"an override naming a file the source set does not carry is a mutation that never applied, and "
		+ "every assertion built on it would pass by describing unmutated source");
	return patched;
}

const rebuild = (overrides = {}) => assemble(substitute(overrides));

function mutate(rel, find, replace) {
	const source = sourceOf(rel);
	const mutated = source.replace(find, replace);
	assert.notEqual(mutated, source, `the ${rel} mutation must apply, or this test proves nothing`);
	return rebuild({ [rel]: mutated });
}

test("the committed join still matches the module source, and passes its own controls", () => {
	assert.deepEqual(checkJoinControls(artifact), []);
	assert.deepEqual(checkJoinControls(rebuild()), [],
		"the controls must be run against a FRESH extraction too: a walk that stops descending leaves the "
		+ "committed JSON untouched, so every control keyed on it stays green while the only red is a "
		+ "drift notice whose advice is to regenerate — the one action that bakes the loss in");
	assert.deepEqual(rebuild().join, artifact.join,
		"module source moved without regenerating we-set.json — run derive-we-set.mjs");
});

test("the join is non-vacuous: both sides carry rows, and every read names where it was read", () => {
	const { join } = artifact;
	assert.ok(join.entity_captures.length >= 20, `entity captures: ${join.entity_captures.length}`);
	assert.ok(join.counts.specific_data_reads >= 40, `specific_data reads: ${join.counts.specific_data_reads}`);
	assert.ok(join.counts.entity_reads >= 20, `entity reads: ${join.counts.entity_reads}`);
	assert.ok(artifact.handler_captures.flatMap(row => row.fields).length >= 80);
	for (const row of join.payload_reads) {
		assert.ok(row.sites.length > 0, `${row.plane}.${row.field} is listed as read by nobody`);
		for (const site of row.sites) {
			assert.match(site, /^[a-z_/-]+\.lua:\S+$/,
				`${row.plane}.${row.field} carries the site "${site}", which names no file:function — a row `
				+ "nobody can look up is a row nobody can dispute");
		}
	}
});

test("a LIVE entity read is not a payload read — the discriminator #260 applied by eye", () => {
	const source = [
		"function M.restore(entity, entity_data)",
		"  local sd = entity_data.specific_data",
		"  local bound = entity.mining_target ~= nil",
		"  local wanted = sd.mining_progress",
		"end",
	].join("\n");
	const rows = scanPayloadTouches([{ rel: "synthetic.lua", source }], "read",
		declaredFunctions([{ rel: "synthetic.lua", source }])).touches;
	assert.deepEqual(rows.map(row => `${row.plane}.${row.field}`).sort(),
		["entity.specific_data", "specific_data.mining_progress"],
		"entity.mining_target is a read of the LIVE entity, not of the payload: counting it would report "
		+ "the captured field as consumed while nothing reads the capture, which is how #260 had to "
		+ "re-verify fourteen names by reading the readers instead of grepping them");
});

test("a local rebound to something else does NOT donate its reads to the payload", () => {
	const source = [
		"function M.a(entity_data)",
		"  local data = entity_data.specific_data",
		"  return data.carried",
		"end",
		"function M.b(job)",
		"  local data = job.unrelated_table",
		"  return data.not_a_payload_field",
		"end",
	].join("\n");
	const rows = scanPayloadTouches([{ rel: "synthetic.lua", source }], "read",
		declaredFunctions([{ rel: "synthetic.lua", source }])).touches;
	assert.deepEqual(rows.map(row => row.field).sort(), ["carried", "specific_data"],
		"`data` is the commonest local name in this module tree — resolving it file-wide would let an "
		+ "unrelated table's members read as consumed payload fields, and a genuinely dead capture named "
		+ "like one of them would join clean");
});

test("an `or {}` alias and a same-function rebind both resolve", () => {
	const source = [
		"function M.a(entity_data)",
		"  local sd = entity_data.specific_data or {}",
		"  return sd.guarded",
		"end",
	].join("\n");
	const rows = scanPayloadTouches([{ rel: "synthetic.lua", source }], "read",
		declaredFunctions([{ rel: "synthetic.lua", source }])).touches;
	assert.ok(rows.some(row => row.plane === "specific_data" && row.field === "guarded"),
		"`local sd = entity_data.specific_data or {}` is the shape create_entity uses; reading the `or` "
		+ "chain as a value rather than an alias drops every field that guard protects");
});

test("CALIBRATION RED (direction A): the ghost_type capture #260 deleted is reported again", () => {
	const fresh = mutate(HANDLERS_REL,
		"  local data = {\n    ghost_name = entity.ghost_name\n  }",
		"  local data = {\n    ghost_name = entity.ghost_name,\n    ghost_type = entity.ghost_type\n  }");
	const rows = fresh.join.captured_without_consumer.filter(row => row.field === "ghost_type");
	assert.deepEqual(rows.map(joinKey), ["specific_data:entity-ghost:ghost_type"],
		"the reconstruction restores the exact constructor 13e7776 removed, so the join must report the "
		+ "entity-ghost category capturing a field with no consumer");
	assert.ok(checkJoinControls(fresh).some(failure =>
		failure.includes("captured field specific_data:entity-ghost:ghost_type is not in "
			+ "capture-join-accounted.json")),
	"and the control must refuse the artifact, not merely list the row inside it");
});

test("CALIBRATION RED (direction B): a restore-side read no scanner feeds is reported", () => {
	const fresh = mutate(DESERIALIZER_REL,
		"  local data = entity_data.specific_data\n",
		"  local data = entity_data.specific_data\n\n"
		+ "  if data.constant_signals then\n    log(\"probe\")\n  end\n");
	const rows = fresh.join.consumed_without_producer.filter(row => row.field === "constant_signals");
	assert.deepEqual(rows.map(joinKey),
		["specific_data:core/deserializer.lua:Deserializer.restore_entity_state:constant_signals"],
		"this is the shape #271 deleted — a restore arm reading a field no exporter produces. That arm sat "
		+ "on the control_behavior plane, which this join does not cover, so the probe transposes the shape "
		+ "onto the specific_data plane it does");
	assert.ok(checkJoinControls(fresh).some(failure =>
		failure.includes("consumed field specific_data:core/deserializer.lua:"
			+ "Deserializer.restore_entity_state:constant_signals is not in capture-join-accounted.json")),
	"and the control must refuse the artifact");
});

test("MUTATION KILL: the empty ledger leaves every live one-sided row unaccounted", () => {
	const failures = checkJoinControls(artifact, EMPTY_LEDGER);
	assert.ok(artifact.join.consumed_without_producer.length > 0,
		"there must be live rows for an emptied ledger to expose, or this test proves nothing");
	for (const row of artifact.join.consumed_without_producer) {
		assert.ok(failures.some(failure => failure.includes(`consumed field ${joinKey(row)} is not in`)),
			`${joinKey(row)} went unreported against an empty ledger — its account is not load-bearing`);
	}
});

test("MUTATION KILL: an account left behind after the field is joined turns red too", () => {
	const stale = {
		captured_without_consumer: [],
		consumed_without_producer: [{
			plane: "specific_data",
			site: "core/deserializer.lua:Deserializer.restore_entity_state",
			field: "held_item",
			reason: "synthetic",
		}],
	};
	assert.ok(artifact.join.payload_reads.some(row => row.field === "held_item"),
		"held_item is read and produced today, which is exactly when a leftover account has to speak up");
	assert.ok(checkJoinControls(artifact, stale).some(failure => failure.includes(
		"consumed field specific_data:core/deserializer.lua:Deserializer.restore_entity_state:held_item "
		+ "is accounted")),
	"a stale entry is standing permission for that same field to go unproduced again with nothing going "
		+ "red — the ledger is checked in BOTH directions or it is a suppression list");
});

test("an account covers ONE SITE: the same field read elsewhere is a separate account", () => {
	const beacon = LIVE_LEDGER.consumed_without_producer.filter(row => row.field === "_beacon_placed");
	assert.equal(beacon.length, 2,
		"_beacon_placed is read at two sites, and each carries its own account — one account covering both "
		+ "would let either read survive the other's removal with nothing going red");
	const oneAccount = {
		captured_without_consumer: [],
		consumed_without_producer: [beacon[0], ...LIVE_LEDGER.consumed_without_producer
			.filter(row => row.field !== "_beacon_placed")],
	};
	const failures = checkJoinControls(artifact, oneAccount);
	assert.ok(failures.some(failure => failure.includes(`consumed field ${joinKey(beacon[1])} is not in`)),
		"the second site must still be reported while the first one's entry is honoured");
	assert.equal(failures.some(failure => failure.includes(`${joinKey(beacon[0])} is not in`)), false);
});

test("a ledger row with no reason is refused", () => {
	const noReason = {
		captured_without_consumer: [],
		consumed_without_producer: LIVE_LEDGER.consumed_without_producer
			.map(row => ({ ...row, reason: "  " })),
	};
	assert.ok(checkJoinControls(artifact, noReason).some(failure => failure.includes("carries no reason")),
		"nothing mechanical reads the reason, so the only thing keeping it honest is that a row cannot "
		+ "exist without one");
});

test("MUTATION KILL: dropping the restore-rule arm orphans every rule-only capture", () => {
	const withRules = analyzeJoin({
		captureFiles: sources.captureFiles,
		restoreFiles: sources.restoreFiles,
		handlerCaptures: artifact.handler_captures,
		restoreRuleFields: artifact.restore_rules.map(rule => rule.field),
	});
	const withoutRules = analyzeJoin({
		captureFiles: sources.captureFiles,
		restoreFiles: sources.restoreFiles,
		handlerCaptures: artifact.handler_captures,
		restoreRuleFields: [],
	});
	assert.equal(withRules.counts.captured_without_consumer, 0);
	assert.ok(withoutRules.counts.captured_without_consumer >= 30,
		`dropping the rule arm reported ${withoutRules.counts.captured_without_consumer} orphans — a rule `
		+ "row IS the consumer for a field the deserializer never names in source, so an arm that stops "
		+ "contributing them must be visible as a wall of direction-A rows, not as silence");
	assert.ok(withoutRules.captured_without_consumer.some(row => row.field === "link_id"));
});

test("MUTATION KILL: refusing a goto-containing scope would drop the reads inside it", () => {
	const inventories = artifact.join.payload_reads
		.find(row => row.plane === "specific_data" && row.field === "inventories");
	assert.ok(inventories.sites.includes("core/deserializer.lua:Deserializer.restore_inventories"),
		"restore_inventories contains a goto; the reachability arm refuses that whole scope by name, and a "
		+ "read walk that copied the refusal would report the reads inside it as absent");
	const blinded = JSON.parse(JSON.stringify(artifact));
	const row = blinded.join.payload_reads
		.find(entry => entry.plane === "specific_data" && entry.field === "inventories");
	row.sites = row.sites.filter(site => site !== "core/deserializer.lua:Deserializer.restore_inventories");
	assert.ok(checkJoinControls(blinded).some(failure => failure.includes(
		"the specific_data read of \"inventories\" at core/deserializer.lua:Deserializer.restore_inventories "
		+ "went missing")),
	"and the site control must go red, so a refusal added later cannot pass as a clean walk");
});

test("MUTATION KILL: the alias-parameter hop is what keeps bonus_mining_progress joined", () => {
	const fresh = mutate(ACTIVE_STATE_REL,
		/(\n\s+)ActiveStateRestoration\.queue_mining_progress\(entity, sd\)/,
		"$1ActiveStateRestoration.queue_mining_progress(entity, nil)");
	assert.equal(fresh.join.alias_params.includes("ActiveStateRestoration.queue_mining_progress#1"), false,
		"with no payload table passed there, the callee's parameter is no longer bound as one");
	assert.ok(fresh.join.captured_without_consumer.some(row => row.field === "bonus_mining_progress"),
		"bonus_mining_progress is read ONLY through that parameter, so the hop is the whole reason the "
		+ "field joins — without it the derivation would report a live capture as dead");
	assert.ok(checkJoinControls(fresh).some(failure =>
		failure.includes("bonus_mining_progress")));
});

test("MUTATION KILL: a per-function payload root that stops resolving turns its control red", () => {
	assert.deepEqual(artifact.join.scoped_roots, SCOPED_ROOT_CONTROLS,
		"the derived per-function roots and the control list must agree today");
	const fresh = mutate(LATCH_REL, "local sd = record.specific_data", "local sd = record.specifics");
	assert.deepEqual(fresh.join.scoped_roots, [],
		"`record` is a payload root only because that read makes it one");
	assert.ok(checkJoinControls(fresh).some(failure =>
		failure.includes("the per-function payload roots moved")),
	"a root that silently stops resolving takes a whole function's reads out of the join, and those "
		+ "fields then read as captured-by-nobody");
});

test("MUTATION KILL: a capture-side write that disappears is seen, not smoothed over", () => {
	const fresh = mutate("export_scanners/entity-scanner.lua",
		"    entity_data.infinity_pipe_filter = pipe_filter",
		"    local dropped = pipe_filter");
	assert.equal(fresh.join.entity_captures.some(row => row.field === "infinity_pipe_filter"), false,
		"the derivation must SEE the removed capture disappear");
	const failures = checkJoinControls(fresh);
	assert.ok(failures.some(failure => failure.includes("entity capture \"infinity_pipe_filter\" went missing")),
		"the infinity-pipe filter is the capture this repo has already lost silently once — its removal "
		+ "must refuse the artifact");
	assert.ok(failures.some(failure => failure.includes(
		"consumed field entity:core/deserializer.lua:Deserializer.restore_entity_filters:infinity_pipe_filter"
		+ " is not in")),
	"and the read left behind becomes a consumed field with no producer, which is the same loss seen "
		+ "from the other side");
});
