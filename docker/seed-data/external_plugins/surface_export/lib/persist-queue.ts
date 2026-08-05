/**
 * Serialises writes to a single file path, so two concurrent writers can never interleave.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every one of this plugin's database files is written through `@clusterio/lib`'s `safeOutputFile`,
 * which is a write-to-temp-then-`rename`. That is the right shape: `rename` is atomic within a
 * filesystem, so neither a reader nor a crash can observe a half-written file.
 *
 * But the temp path is DERIVED FROM THE TARGET — `${name}.tmp${ext}` beside it, a fixed name, not a
 * unique one. The helper therefore assumes a single writer per path. Two overlapping writes to one
 * target both open the same temp file, interleave their `writeFile` syscalls, and then one `rename`
 * publishes bytes that may be a mix of both payloads while the other `rename` finds nothing left and
 * throws ENOENT. The atomic rename protects against CRASHES, not against CONCURRENCY.
 *
 * That is not theoretical here. Three call sites fire a persist without awaiting it —
 * `controller.ts` `void this.persistPendingTransfers()` (twice) and `void
 * this.persistSourceCommitMarkers()` — so two writes to one path are in flight by construction, with
 * no argument about scheduling needed. Those two files hold two-phase-commit recovery state: the
 * pending transfer intents and the source COMMIT markers the controller uses to reason about
 * in-flight transfers after a restart. A truncated write there corrupts the record that exists
 * specifically to survive a crash.
 *
 * The observed symptom was ~143 `ENOENT ... rename 'surface_export_storage.tmp.json'` errors on the
 * export store. ENOENT is the BENIGN outcome of the race — the loser simply fails and logs. The
 * dangerous outcome is silent: a `writeFile` interleaving with the other's `rename`, publishing a
 * truncated file that then fails to parse at next boot.
 *
 * WHAT THIS DOES NOT DO
 * ---------------------
 * It serialises within ONE controller process. It is not a lock against a second process writing the
 * same file — nothing in this plugin does that, and a real inter-process guarantee would need an
 * advisory lock file, which would be a much larger change for a risk that does not currently exist.
 */

/**
 * Tail of the write chain per resolved path. Keyed by the path string the caller passes, so callers
 * must pass a stable, already-resolved path (all of ours are fields computed once at init).
 *
 * Bounded by construction: this plugin has five database files, so the map holds at most five
 * entries for the process lifetime. No eviction needed, and evicting would risk dropping a chain
 * that still has work queued behind it.
 */
const writeChains = new Map<string, Promise<unknown>>();

/**
 * Queue `produce` to run once every previously-queued write for `path` has settled.
 *
 * Returns a promise for THIS write specifically, so each caller still observes its own success or
 * failure. A failed write does not cancel or poison the writes queued behind it: the chain advances
 * on settlement, not on success. Nothing is swallowed — `Promise.allSettled` is used to WAIT for the
 * predecessor without adopting its rejection, rather than a `.catch` that would discard an error.
 *
 * Ordering note for callers: the payload is captured by the caller BEFORE enqueueing, so the file
 * ends up holding the payload of the last write to be *enqueued*, not the last to be computed. Every
 * caller here serialises a full in-memory snapshot immediately before enqueueing, so the last
 * enqueued payload is also the most recent state — which is the intended result.
 */
export function enqueueWrite<T>(path: string, produce: () => Promise<T>): Promise<T> {
	const previous = writeChains.get(path) ?? Promise.resolve();
	const run = Promise.allSettled([previous]).then(() => produce());
	writeChains.set(path, run);
	return run;
}

/**
 * Test seam: drop all chains. Only for tests that want isolation between cases — production never
 * calls this, because discarding a chain mid-flight would readmit the interleaving this prevents.
 */
export function resetWriteQueuesForTest() {
	writeChains.clear();
}
