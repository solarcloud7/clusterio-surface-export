// testkit — one front door for the instruments this repo keeps re-deriving by hand.
//
// DESIGN RULE (the reason this exists at all). Every addition here must make the NEXT piece of work
// strictly smaller. A change that merely describes a hazard is non-decreasing: the hazard is still
// there and there is now more to maintain. The metric is the cost of the N+1th test.
//
// Measured baseline, counted from the two pads promoted in #138 (commit 3069ebf), not guessed:
//   * a test using an EXISTING physical_read costs 1 file   (manifest.json)
//   * a test needing a NEW property costs 4 files           (manifest.json, lifecycle-engine.lua,
//     manifest.mjs PHYSICAL_READS, manifest.test.mjs counts)
// The 4 is really "one read kind, declared in three places". Collapsing that is the highest-value
// remaining item and is deliberately NOT in this first cut — it edits the lifecycle engine, so it
// goes through the di-change/code-review gate as its own change.
//
// WHAT IS REAL HERE. Only exportInspect and referentialIntegrity. The rest of the intended surface
// (reset, executeTransfer, registerTest, enable/disable) THROWS with a pointer to the existing
// machinery rather than shipping a stub. A stub that quietly succeeds is a vacuous pass, which is
// the exact failure mode this repo keeps closing — a testkit that lies is worse than no testkit.
import { exportInspect, inspectPayloadFile, resolvePlatformIndex } from "./export-inspect.mjs";
import { explainBlackBox, explainBlackBoxFile, formatExplanation } from "./blackbox-explain.mjs";
import { readTransactionLogStore } from "./log-query.mjs";
import { resolvePath } from "./path-oracle.mjs";
import {
	formatFindings, referentialIntegrityAnchors, referentialIntegrityStatic,
} from "./referential-integrity.mjs";

const notYet = (name, useInstead) => () => {
	throw new Error(`testkit.${name}() is not implemented yet. Use ${useInstead} — and if you are ` +
		`about to add it here, note that it wraps a DESTRUCTIVE operation and must keep the ` +
		`preflight (assertLeaseClean) that batch-lifecycle already runs, not skip it for convenience.`);
};

export const testkit = {
	// --- implemented -----------------------------------------------------------------------------

	/** Export a platform and inspect what the payload actually carries. Read-only. */
	exportInspect,
	/** Inspect a payload already on disk (CI artifact, banked black box). */
	inspectPayloadFile,
	/** Platform names collide; resolve to the unique per-force index, failing loud on ambiguity. */
	resolvePlatformIndex,

	/**
	 * Resolve a dotted path through a transaction-log entry or debug dump, and when it MISSES, name
	 * the REAL path. A wrong path returning an empty value is what made a typo read as a missing
	 * feature; `resolvePath` never does that — check `.ok`, which is strictly boolean.
	 */
	resolvePath,
	/** The controller transaction-log store, as an array. Throws with a diagnosis, never returns []. */
	readTransactionLogStore,

	/** Explain a banked failure black box, offline: diff rows, self-report vs physical scan, FAQ triage hint. */
	explainBlackBox,
	explainBlackBoxFile,
	formatExplanation,

	/**
	 * Cross-reference integrity. `mode: "static"` needs no cluster (CI-safe).
	 * `mode: "anchors"` needs a live inspector and checks every fixture anchor resolves.
	 */
	referentialIntegrity({ mode = "static", inspector, platformName, root } = {}) {
		if (mode === "static") return referentialIntegrityStatic({ root });
		if (mode === "anchors") {
			if (!inspector) {
				throw new Error('testkit.referentialIntegrity({mode:"anchors"}) needs an inspector from ' +
					"exportInspect(). Refusing to report a pass without one — a check that silently skips " +
					"is a vacuous pass.");
			}
			return referentialIntegrityAnchors(inspector, { root, platformName });
		}
		throw new Error(`unknown referentialIntegrity mode "${mode}" (expected "static" or "anchors")`);
	},

	formatFindings,

	// --- intended, not yet built ------------------------------------------------------------------

	reset: notYet("reset", "createBatchLifecycle().loadGoldenPair() in tests/lab-gallery/batch-lifecycle.mjs"),
	executeTransfer: notYet("executeTransfer", "tests/integration/gallery-suite/run-tests.mjs, " +
		"or tools/surface-export/transfer-platform.ps1 for a one-off"),
	registerTest: notYet("registerTest", "a fixture entry in tests/lab-gallery/manifest.json"),
	enable: notYet("enable", "the fixture's lifecycle.act / runnerExcluded keys in manifest.json"),
	disable: notYet("disable", "the fixture's lifecycle.act / runnerExcluded keys in manifest.json"),
};

export default testkit;
export {
	exportInspect, inspectPayloadFile, resolvePlatformIndex, formatFindings,
	explainBlackBox, explainBlackBoxFile, formatExplanation,
	resolvePath, readTransactionLogStore,
};
