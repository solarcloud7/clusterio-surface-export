/**
 * @file shared/utils.ts
 * @description Pure helpers shared by BOTH build targets — the Node build (tsc → dist/node) and the web
 * build (webpack → dist/web). Lives in `shared/` (already in both tsconfigs, alongside dto.ts) and is kept
 * strictly dependency-free (no `@clusterio`, no Node/browser-only globals beyond Date/Math) so webpack
 * bundles it directly and it can never drag `@clusterio` into the web bundle.
 *
 * This is the shared home BECAUSE `helpers.ts` imports `@clusterio/lib` (so the web must not import from it)
 * and `web/utils.ts` is inside the webpack-only tree (so Node code must not import from it). Previously these
 * functions were byte-for-byte duplicated across `helpers.ts` and `web/utils.ts` (task #97).
 */

/**
 * Human-readable message for any thrown value (Error, string, or an object with a `message`), else `fallback`.
 */
export function getErrorMessage(err: unknown, fallback = "Unknown error"): string {
	if (err instanceof Error) {
		return err.message || fallback;
	}
	if (typeof err === "string") {
		return err || fallback;
	}
	if (err && typeof err === "object" && "message" in err) {
		const message = (err as { message?: unknown }).message;
		if (typeof message === "string" && message) {
			return message;
		}
	}
	return fallback;
}

/**
 * Opaque unique operation/export id: `${prefix}_${epochMs}_${6 random base36 chars}`. Consolidates three
 * near-identical inline generators (transfer id / operation-record / uploaded-export). The random suffix is
 * a disambiguator only — the id is never parsed beyond its prefix.
 */
export function generateOperationId(prefix: string): string {
	return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
