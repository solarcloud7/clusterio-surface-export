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

	exportInspect,
	inspectPayloadFile,
	resolvePlatformIndex,

	resolvePath,
	readTransactionLogStore,

	explainBlackBox,
	explainBlackBoxFile,
	formatExplanation,

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
