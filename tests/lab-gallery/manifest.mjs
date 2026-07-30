import { readFileSync } from "node:fs";
import { FAIL_SAFE_HOOKS, NON_DESTRUCTIVE_HOOKS } from "../../docker/seed-data/external_plugins/surface_export/scripts/fail-safe-hooks.mjs";

// (CORPUS_EXCLUDED is GONE: exported, imported by nothing, already empty — and it had drifted from
// the Lua corpus_excluded table it claimed to mirror, which itself belonged to a census gate that
// was never called. Both copies deleted 2026-07-26.)

// The reload meters build their reading from a Lua table, which cannot carry a JSON null (Lua drops
// nil keys). They therefore represent the semantic "no mining target" (manifest miningTarget: null)
// as the explicit sentinel `false`, which is ALWAYS present in the emitted reading — so a dropped
// meter read is an absent field the gate rejects loudly, never normalized to a passing value. This
// translates the manifest's semantic value to what the meter emits (the manifest stays the source of
// truth; the meter merely cannot spell null).
export function meterMiningTarget(manifestValue) {
	return manifestValue === null ? false : manifestValue;
}

export function loadGalleryManifest(repoRoot) {
	return JSON.parse(readFileSync(new URL("tests/lab-gallery/manifest.json", repoRoot), "utf8"));
}

function sameJson(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

export function validateGalleryManifest(manifest, { requireArtifacts = true } = {}) {
	if (manifest?.schema !== "surface-export-lab-gallery-v3") throw new Error("unexpected gallery schema");
	if (manifest.engineVersion !== "2.1.11") throw new Error(`unsupported gallery engine ${manifest.engineVersion}`);
	if (!manifest.mods || manifest.mods.base !== manifest.engineVersion || manifest.mods["space-age"] !== manifest.engineVersion) {
		throw new Error("gallery mod pin set is incomplete");
	}
	for (const role of ["source", "destination"]) {
		const save = manifest.saves?.[role];
		if (save?.role !== role) throw new Error(`missing ${role} save role`);
		if (!/^lab-gallery-[a-z0-9-]+$/.test(save.name || "")) throw new Error(`invalid ${role} save name`);
		if (!/^docker\/seed-data\/lab-saves\/.+\.zip$/.test(save.artifact || "")) throw new Error(`invalid ${role} artifact path`);
		if (!sameJson(save.mods, manifest.mods)) throw new Error(`${role} save mod pins differ from the gallery`);
		if (requireArtifacts && (!/^[A-F0-9]{64}$/.test(save.sha256 || "") || !save.expectedCensus)) {
			throw new Error(`artifact metadata pending for ${role}`);
		}
	}
	if (!Array.isArray(manifest.labs) || manifest.labs.length === 0) throw new Error("gallery has no labs");
	const ids = new Set();
	const zones = new Set();
	for (const lab of manifest.labs) {
		if (!lab?.id || ids.has(lab.id)) throw new Error(`duplicate or missing lab id ${lab?.id}`);
		ids.add(lab.id);
		if (!lab.title || !lab.purpose || !lab.sourcePath) throw new Error(`incomplete lab ${lab.id}`);
		if (!Number.isInteger(lab.zone?.x) || !Number.isInteger(lab.zone?.y)) throw new Error(`invalid zone ${lab.id}`);
		const zone = `${lab.zone.x},${lab.zone.y}`;
		if (zones.has(zone)) throw new Error(`duplicate zone ${zone}`);
		zones.add(zone);
	}
	if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0) throw new Error("gallery has no fixtures");
	const fixtureIds = new Set();
	let sourceFixtures = 0;
	let destinationFixtures = 0;
	for (const fixture of manifest.fixtures) {
		if (!fixture?.id || fixtureIds.has(fixture.id)) throw new Error(`duplicate or missing fixture id ${fixture?.id}`);
		fixtureIds.add(fixture.id);
		if (!Number.isInteger(fixture.revision) || fixture.revision < 1) throw new Error(`invalid revision for ${fixture.id}`);
		if (!ids.has(fixture.labId)) throw new Error(`unknown lab ${fixture.labId} for ${fixture.id}`);
		if (!fixture.name || !fixture.purpose || !fixture.category) throw new Error(`incomplete fixture ${fixture.id}`);
		// owningRunner is a REQUIRED provenance key with an EXPLICIT per-fixture opt-out — never a
		// blanket relaxation. It is either a "tests/..." runner path, or null accompanied by an
		// owningRunnerWaiver reason (the consumables own no single integration runner). A fixture that
		// omits the key entirely is a validation error, so a real runner cannot be silently dropped.
		if (!("owningRunner" in fixture)) throw new Error(`missing owningRunner for ${fixture.id}`);
		if (fixture.owningRunner === null) {
			if (typeof fixture.owningRunnerWaiver !== "string" || !fixture.owningRunnerWaiver) {
				throw new Error(`owningRunner opt-out for ${fixture.id} needs an owningRunnerWaiver reason`);
			}
		} else if (typeof fixture.owningRunner !== "string" || !/^tests\/.+/.test(fixture.owningRunner)) {
			throw new Error(`invalid owningRunner for ${fixture.id}`);
		}
		if (fixture.saveRole === "source") sourceFixtures += 1;
		else if (fixture.saveRole === "destination") destinationFixtures += 1;
		else throw new Error(`invalid save role for ${fixture.id}`);
		if (fixture.engineVersion !== manifest.engineVersion || !sameJson(fixture.mods, manifest.mods)) {
			throw new Error(`engine or mod pins differ for ${fixture.id}`);
		}
		// (expectedTerminalVerdict was deleted 2026-07-26: declared on all 27 fixtures, validated here,
		// consumed by NOTHING — and its values had already drifted into disagreement. Dead schema.)
		if (!fixture.invariant || fixture.independentOracleRequired !== true) {
			throw new Error(`incomplete contract for ${fixture.id}`);
		}
		if (!fixture.fingerprint || typeof fixture.fingerprint !== "object") throw new Error(`missing fingerprint for ${fixture.id}`);
		// v3: every fixture declares a padKind (pad = a stamped test-foundation cell on the omnibus
		// grid; platform = its own platform/hub fixture; surface = a bare-surface fixture). Pads carry
		// their grid origin {x,y}; the migration retired every surface fixture, so a `surface` padKind
		// is accepted but no fixture uses it after the belt pads landed on the grid.
		if (!["pad", "platform", "surface"].includes(fixture.padKind)) throw new Error(`invalid padKind for ${fixture.id}`);
		if (fixture.padKind === "pad" && (!fixture.origin || !Number.isInteger(fixture.origin.x) || !Number.isInteger(fixture.origin.y))) {
			throw new Error(`pad ${fixture.id} needs an integer origin {x,y}`);
		}
		if ("lifecycle" in fixture) validateLifecycle(fixture);
	}
	return { labs: manifest.labs.length, fixtures: manifest.fixtures.length, sourceFixtures, destinationFixtures };
}

// ---- lifecycle (setup / act / verify) validation --------------------------------------------------
// The pad lifecycle framework: declarative setup ops, an act selector, and a declarative verify
// list. Rules enforced here are DI teeth, not style: arm_hook is restricted to the pre-gate
// fail-safe set (a leaked hook must fail-safe, a mutating test hook must be fail-safe on leak class); report_field checks require a
// physical witness (the lint-test-grounding rule at manifest level); setup writes are confined to
// declared mutable anchors (the pristine-left-half rule).
const LIFECYCLE_ACTS = new Set(["copy-paste", "transfer", "clone"]);
// "property" is the LAST entry this set should ever need for a plain engine property. It takes a
// dotted `path` and reads it off the resolved entity, so a fixture asserting a property the engine
// already exposes ("temperature", "burner.remaining_burning_fuel") is a manifest.json edit alone —
// where each such property previously cost a branch in lifecycle-engine.lua, an entry here, and a
// count bump in manifest.test.mjs. Add a named read kind only for something a property walk cannot
// express (aggregation over an area, a method call, a derived value).
// "belt_stats" selects one field of FixtureMeters.measure_belt_combined (the canonical belt
// instrument — delegation, never a second copy of its definitions). It exists to carry a belt
// fixture's FULL law to the transfer destination (the 37-vs-13 over-compression incident).
// "surface_entity_count_stable" = surface_entity_count minus transient debris classes (spills,
// explosion effects, projectiles) — the pin for LIVE-factory fixtures whose raw count breathes
// (measured 2026-07-27 on the workhorse: 1359<->1360 between runs from a spill + explosions).
const PHYSICAL_READS = new Set(["item_count", "held", "crafting_progress", "spoil_percent", "fluid", "entity_present", "platform_present", "surface_entity_count", "surface_entity_count_stable", "fluid_stats", "infinity_pipe_filter", "property", "belt_stats"]);
// TWO evaluators, two capability sets — and conflating them is a real bug, not pedantry. A
// physical_read is compared in Lua by lifecycle-engine's compare_op, which implements all of these.
// A report_field is compared in NODE by evalReportField (pad-transfer-suite/run-tests.mjs), which
// implements ONLY eq and throws on anything else. Validating a report_field against the physical set
// let `approx` pass manifest validation and then throw AFTER the real transfer had already fired —
// a full suite run spent to surface a typo that is knowable statically.
//
// "approx" compares with the same 1e-9 ULP allowance as DOUBLE_EPSILON in batch-lifecycle.mjs, for
// the engine floats the fixtures pin exactly (0.7000000000000005). "eq" stays bit-exact.
const CHECK_OPS = new Set(["eq", "approx", "ge", "le", "between", "monotone"]);
// Keep in step with evalReportField: widening it there without widening this only costs a late
// failure, but widening THIS without widening there produces a manifest that validates and cannot run.
const REPORT_FIELD_OPS = new Set(["eq"]);
const LIFECYCLE_ENDS = new Set(["source", "dest"]);
const LIFECYCLE_EXPECTS = new Set(["success", "gate-failure", "census-abort"]);
const TRANSFER_SUITE = "tests/integration/gallery-suite/run-tests.mjs";

function validateLifecycle(fixture) {
	const lc = fixture.lifecycle;
	const id = fixture.id;
	if (!lc || typeof lc !== "object") throw new Error(`lifecycle for ${id} must be an object`);
	if (lc.version !== 1) throw new Error(`lifecycle for ${id}: unsupported version ${lc.version}`);
	const mutable = new Set(lc.mutable || []);
	const anchorNames = new Set((fixture.anchors || []).map(anchor => anchor.name).filter(Boolean));
	for (const name of mutable) {
		if (name !== "vault" && !anchorNames.has(name)) throw new Error(`lifecycle for ${id}: mutable "${name}" is not a named anchor`);
	}
	const act = lc.act ?? "copy-paste";
	if (!Array.isArray(act) && !LIFECYCLE_ACTS.has(act)) throw new Error(`lifecycle for ${id}: invalid act ${act}`);
	if (act === "transfer" && fixture.owningRunner !== TRANSFER_SUITE) {
		throw new Error(`lifecycle for ${id}: act "transfer" requires owningRunner ${TRANSFER_SUITE}`);
	}
	// Sabotage lifecycles (the protocol teeth): `expect: "gate-failure"` means the PRODUCTION gate
	// must REFUSE this transfer — dest discarded, source preserved. Only meaningful for transfer
	// acts, and it must be caused by a declared dest-end sabotage op (never an implicit assumption).
	const expect = lc.expect ?? "success";
	if (!LIFECYCLE_EXPECTS.has(expect)) throw new Error(`lifecycle for ${id}: invalid expect ${expect}`);
	if (expect === "gate-failure" && act !== "transfer") {
		throw new Error(`lifecycle for ${id}: expect "gate-failure" requires act "transfer"`);
	}
	let hasDestSabotage = false;
	for (const op of lc.setup || []) {
		if (!op || typeof op !== "object" || typeof op.op !== "string") throw new Error(`lifecycle for ${id}: malformed setup op`);
		const opEnd = op.end ?? "source";
		if (!LIFECYCLE_ENDS.has(opEnd)) throw new Error(`lifecycle for ${id}: invalid op end "${op.end}"`);
		if (opEnd === "dest") {
			if (act !== "transfer") throw new Error(`lifecycle for ${id}: dest-end ops require act "transfer"`);
			// arm_hook is allowlist-checked + cleanup-disarmed; mutate_force is restore-recorded. A
			// dest-end lua op would be an UNRECORDED escape hatch on the sabotage end (review OBS-1)
			// — not offered until a teardown-recording story exists for it.
			if (!["arm_hook", "mutate_force"].includes(op.op)) {
				throw new Error(`lifecycle for ${id}: op "${op.op}" cannot run on the dest end`);
			}
			hasDestSabotage = true;
		}
		if (op.op === "arm_hook") {
			if (!FAIL_SAFE_HOOKS.has(op.name) && !NON_DESTRUCTIVE_HOOKS.has(op.name)) {
				throw new Error(`lifecycle for ${id}: arm_hook "${op.name}" is not in the fail-safe allowlist`);
			}
		} else if (op.op === "mutate_force") {
			if (op.restore !== true) throw new Error(`lifecycle for ${id}: mutate_force requires restore:true`);
		} else if (op.op === "lua") {
			if (typeof op.reason !== "string" || !op.reason.trim()) throw new Error(`lifecycle for ${id}: lua op requires a reason`);
		} else if (op.op === "spawn_item" || op.op === "spawn_fluid" || op.op === "set_stack_field" || op.op === "set_health") {
			const target = op.into ?? op.locator?.anchor;
			const targetName = typeof target === "string" ? target.replace(/^anchor:/, "") : null;
			if (!targetName || (targetName !== "vault" && !mutable.has(targetName))) {
				throw new Error(`lifecycle for ${id}: ${op.op} targets "${targetName}" which is not a declared mutable anchor`);
			}
		} else {
			throw new Error(`lifecycle for ${id}: unknown setup op "${op.op}"`);
		}
	}
	if (expect === "gate-failure" && !hasDestSabotage) {
		throw new Error(`lifecycle for ${id}: expect "gate-failure" requires a dest-end arm_hook/mutate_force sabotage op`);
	}
	// census-abort (SC-6): the SOURCE census refuses the export — the destination is NEVER
	// contacted. Sabotage is a SOURCE-end arm of the census-omission hook; dest-end anything is
	// a contradiction (there is no dest side to this expect).
	if (expect === "census-abort") {
		const hasCensusArm = (lc.setup || []).some(op =>
			op?.op === "arm_hook" && op.name === "test_force_census_omission" && (op.end ?? "source") === "source");
		if (!hasCensusArm) {
			throw new Error(`lifecycle for ${id}: expect "census-abort" requires a source-end arm_hook of test_force_census_omission`);
		}
		if ((lc.setup || []).some(op => (op?.end ?? "source") === "dest")) {
			throw new Error(`lifecycle for ${id}: expect "census-abort" forbids dest-end ops (the dest is never contacted)`);
		}
		if ((lc.verify || []).some(check => check?.end === "dest")) {
			throw new Error(`lifecycle for ${id}: expect "census-abort" forbids dest-end checks (no dest platform ever exists)`);
		}
	}
	const checks = lc.verify || [];
	let physicalWitness = !(checks.some(check => check?.check === "fingerprint" && check.enabled === false));
	let hasReportField = false;
	let hasSourcePreservedWitness = false;
	for (const check of checks) {
		if (!check || typeof check !== "object" || typeof check.check !== "string") throw new Error(`lifecycle for ${id}: malformed verify check`);
		if (check.end !== undefined) {
			if (!LIFECYCLE_ENDS.has(check.end)) throw new Error(`lifecycle for ${id}: invalid check end "${check.end}"`);
			if (act !== "transfer") throw new Error(`lifecycle for ${id}: check ends require act "transfer"`);
			if (check.end === "source" && check.check === "physical_read") hasSourcePreservedWitness = true;
		}
		// A refused transfer has NO dest platform: gate-failure/census-abort physical reads must
		// explicitly declare end "source" (the engine's default end is "dest" — an implicit
		// default here would silently point the witness at a platform that never exists).
		if ((expect === "gate-failure" || expect === "census-abort") && check.check === "physical_read" && check.end !== "source") {
			throw new Error(`lifecycle for ${id}: ${expect} physical_read checks must declare end "source"`);
		}
		if (check.check === "physical_read") {
			if (!PHYSICAL_READS.has(check.read)) throw new Error(`lifecycle for ${id}: unknown physical read "${check.read}"`);
			if (!CHECK_OPS.has(check.op)) throw new Error(`lifecycle for ${id}: unknown check op "${check.op}"`);
			// FULL-DOMAIN VACUITY GUARD (review 2026-07-30): a progress property is engine-bounded to
			// [0,1], so `between [0,1]` evaluates and satisfies the zero-reads guard yet no input can
			// ever fail it — the exact shape two unfrozen re-pins quietly took. A live progress value
			// spans its whole domain; the honest options are a NARROWER mechanism-derived bound or no
			// check at all, never the domain itself.
			if (check.op === "between" && Array.isArray(check.expected)
				&& typeof check.path === "string" && /progress$/.test(check.path)
				&& check.expected[0] <= 0 && check.expected[1] >= 1) {
				throw new Error(`lifecycle for ${id}: "${check.path}" between [${check.expected}] spans the ` +
					`property's entire domain — the check cannot fail. Use a narrower mechanism-derived bound ` +
					`or drop the check with the reason recorded in the invariant.`);
			}
			if (check.read === "belt_stats") {
				// Lua re-validates (the boundary); this fails a typo fast without a cluster.
				if (typeof check.field !== "string" || !/^[A-Za-z][A-Za-z0-9]*$/.test(check.field)) {
					throw new Error(`lifecycle for ${id}: belt_stats needs a "field" name (a measure_belt_combined key)`);
				}
				if (!check.locator?.area) {
					throw new Error(`lifecycle for ${id}: belt_stats needs an area locator (the pad rect)`);
				}
			}
			if (check.read === "property") {
				// The Lua reader re-validates this — that check is the real boundary, since the roster is
				// data from outside. This one exists so a typo fails at manifest-validation time (fast,
				// no cluster) instead of surfacing as a mid-suite red.
				if (typeof check.path !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(check.path)) {
					throw new Error(`lifecycle for ${id}: property read needs a dotted identifier "path" ` +
						`(got ${JSON.stringify(check.path)})`);
				}
				// The entity comes from the fixture's anchors, so there is no prototype name on the check
				// to validate — the "entity_name" rule that used to live here was deleted along with the
				// duplication it policed. An anchor locator is required and resolves against a closed set.
				if (!check.locator?.anchor) {
					throw new Error(`lifecycle for ${id}: property read needs locator.anchor — the anchor ` +
						`carries the entity, so the prototype name is never restated on the check`);
				}
			}
			physicalWitness = true;
		} else if (check.check === "report_field") {
			if (!REPORT_FIELD_OPS.has(check.op)) {
				throw new Error(`lifecycle for ${id}: report_field op "${check.op}" is not implemented by the ` +
					`orchestrator (evalReportField supports: ${[...REPORT_FIELD_OPS].join(", ")}) — this must fail ` +
					`here, not after the transfer has already run`);
			}
			hasReportField = true;
		} else if (check.check === "log_line") {
			if (act !== "transfer" && act !== "clone") throw new Error(`lifecycle for ${id}: log_line checks require a transfer/clone act`);
		} else if (check.check === "census_pass") {
			// SC-6 Phase 4: assert the source census RAN and PASSED on a CLEAN transfer (the
			// positive counterpart to census-abort). Only meaningful on a success transfer.
			if (act !== "transfer") throw new Error(`lifecycle for ${id}: census_pass checks require act "transfer"`);
			if (expect !== "success") throw new Error(`lifecycle for ${id}: census_pass checks require expect "success"`);
		} else if (check.check !== "fingerprint") {
			throw new Error(`lifecycle for ${id}: unknown check "${check.check}"`);
		}
	}
	if (hasReportField && !physicalWitness) {
		throw new Error(`lifecycle for ${id}: report_field checks require at least one physical witness (grounding rule)`);
	}
	// A refused transfer's protective outcome is "source physically intact" — a refusal fixture
	// that never physically reads the preserved source would go green on a broken preservation path.
	if ((expect === "gate-failure" || expect === "census-abort") && !hasSourcePreservedWitness) {
		throw new Error(`lifecycle for ${id}: expect "${expect}" requires a source-end physical_read (source-preserved witness)`);
	}
}

// Render the pad's EXPECT panel section from the verify list — the single source the owner asked
// for ("a list of things we verify programmatically that we put in the description of the test").
export function renderExpectFromLifecycle(fixture) {
	const lc = fixture.lifecycle;
	if (!lc) return null;
	const lines = [];
	const checks = lc.verify || [];
	if ((lc.expect ?? "success") === "gate-failure") {
		lines.push("GATE MUST REFUSE: dest discarded, source preserved");
	} else if (lc.expect === "census-abort") {
		lines.push("CENSUS MUST REFUSE: export aborted, dest never contacted, source preserved + unlocked");
	}
	if (!checks.some(check => check?.check === "fingerprint" && check.enabled === false)) {
		lines.push("fingerprint matches the manifest pin");
	}
	for (const check of checks) {
		const endTag = check.end ? `[${check.end}] ` : "";
		if (check.check === "physical_read") {
			const where = check.locator?.anchor || check.locator?.platform || "area";
			// A property read's identity is its PATH, not the word "property" — without it every
			// property check on a pad renders as the same "area: property eq 500" line, and two on one
			// pad are indistinguishable both on the in-world EXPECT panel and in a failure message.
			// A property read's identity is its PATH, not the word "property" — without it every
			// property check renders as "area: property eq 500" and two on one pad are identical.
			// The locator already supplies the entity (it names an anchor), so `where` carries it.
			const what = check.read === "property"
				? check.path
				: (check.item ? `${check.item} ${check.read}` : check.read);
			const bound = check.op === "monotone" ? `monotone (<=${check.driftTicks ?? "?"}t drift)` : `${check.op} ${JSON.stringify(check.expected)}`;
			lines.push(`${endTag}${where}: ${what} ${bound}`);
		} else if (check.check === "report_field") {
			lines.push(`${endTag}report ${check.path} ${check.op} ${JSON.stringify(check.expected)}`);
		} else if (check.check === "log_line") {
			lines.push(`${endTag}log line matches ${check.pattern}`);
		} else if (check.check === "census_pass") {
			lines.push("source census ran + passed (paired-reads, fail-closed)");
		}
	}
	return lines;
}
