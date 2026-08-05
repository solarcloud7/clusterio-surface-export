import fs from "fs/promises";
import { enqueueWrite } from "./persist-queue";

/**
 * The transfer audit ledger: an append-only JSONL record of every transfer, one slim row per
 * lifecycle event.
 *
 * WHY A SECOND FILE INSTEAD OF FIXING THE FIRST
 * ---------------------------------------------
 * `surface_export_transaction_logs.json` is a single JSON array that is read, parsed, upserted,
 * re-serialised and rewritten IN FULL on every persist — measured at 7.62 MB / 453 entries, so
 * ~15.2 MB of I/O and 45 ms of CPU to update ~9 KB. It has no retention of any kind, so that cost
 * grows without bound. Three of this plugin's five database files are capped; that one is not.
 *
 * It cannot simply be capped, because it is the only record that a transfer happened at all, and the
 * owner's requirement is that users can see EVERY transfer to satisfy themselves no duplication
 * occurred. Capping it would trade a cost problem for a trust problem.
 *
 * So the two jobs are split. This ledger answers "did it happen, and what was the verdict" for all
 * time, in rows small enough that keeping them forever is cheap. The existing file keeps its name
 * and its array shape and becomes a bounded window of FAT detail (events, phase timings, validation
 * maps) for recent and interesting transfers.
 *
 * WHY JSONL HERE AND NOT THERE
 * ----------------------------
 * JSONL's advantage is a cheap append to an immutable stream, and it is a poor fit for a keyed
 * upsert — which is exactly what the detail file does (`findIndex`/`splice` per persist). Fat
 * upserted rows in JSONL would accumulate duplicate 9.3 KB entries and need whole-file compaction,
 * paying the rewrite later and in a lump.
 *
 * These rows are ~350 bytes and they are NOT upserted: a duplicate is not waste, it is revision
 * history. The late-verdict path genuinely produces two different verdicts for one transfer, and
 * keeping both is a property the array format never had.
 *
 * ORDERING
 * --------
 * Rows are appended through the per-path write queue, so file position is total order and no
 * sequence number is needed. But the FOLD does not use position: a terminal row beats a start row
 * unconditionally. Transfer IDs are not globally unique forever — `transferPlatform` deliberately
 * replaces a failed record under the same ID, and the gallery batch suites reset the Lua counter and
 * legitimately regenerate identical IDs. A position-only last-wins fold would let a stale start row
 * bury a completed transfer's verdict, which is precisely the "right-looking value from the wrong
 * record" failure the query-path oracle exists to prevent.
 */

/** Bumped only for a change that an older reader could MISREAD, not for additive fields. */
export const AUDIT_ROW_VERSION = 1;

/** Long errors are truncated in the ledger; the untruncated text stays in the detail entry. */
export const AUDIT_ERROR_MAX_CHARS = 512;

export type AuditRowKind = "start" | "terminal";

export interface AuditRow {
	v: number;
	transferId: string;
	rowKind: AuditRowKind;
	savedAt: number;
	operationType: string;
	platformName: string;
	platformIndex: number | null;
	sourceInstanceId: number;
	sourceInstanceName: string | null;
	targetInstanceId: number;
	targetInstanceName: string | null;
	exportId: string | null;
	artifactSizeBytes: number | null;
	status: string;
	startedAt: number | null;
	completedAt: number | null;
	failedAt: number | null;
	lastEventAt: number | null;
	eventCount: number;
	error: string | null;
	errorTruncated?: boolean;
}

export interface LedgerLoadResult {
	rows: AuditRow[];
	/** Lines that could not be used, with enough detail to find them by hand. */
	skipped: Array<{ lineNumber: number; byteOffset: number; reason: string }>;
}

type RowInput = {
	transferId: string;
	rowKind: AuditRowKind;
	savedAt: number;
	eventCount: number;
	lastEventAt: number | null;
	info: {
		operationType?: string;
		platformName?: string;
		platformIndex?: number | null;
		sourceInstanceId?: number;
		sourceInstanceName?: string | null;
		targetInstanceId?: number;
		targetInstanceName?: string | null;
		exportId?: string | null;
		artifactSizeBytes?: number | null;
		status?: string;
		startedAt?: number | null;
		completedAt?: number | null;
		failedAt?: number | null;
		error?: string | null;
	};
};

/**
 * Build one ledger row. Scalars only — never a count map. The item/fluid maps are what make a detail
 * entry 9.3 KB, and a row that carried them would defeat the point of keeping rows forever.
 */
export function buildAuditRow(input: RowInput): AuditRow {
	const info = input.info || {};
	const rawError = info.error ?? null;
	// handleValidationFailure joins up to three error strings, so this field is not bounded by the
	// length of any single message.
	const truncated = typeof rawError === "string" && rawError.length > AUDIT_ERROR_MAX_CHARS;
	const row: AuditRow = {
		v: AUDIT_ROW_VERSION,
		transferId: input.transferId,
		rowKind: input.rowKind,
		savedAt: input.savedAt,
		operationType: info.operationType || "transfer",
		platformName: info.platformName || "Unknown",
		platformIndex: info.platformIndex ?? null,
		sourceInstanceId: info.sourceInstanceId ?? -1,
		sourceInstanceName: info.sourceInstanceName ?? null,
		targetInstanceId: info.targetInstanceId ?? -1,
		targetInstanceName: info.targetInstanceName ?? null,
		exportId: info.exportId ?? null,
		artifactSizeBytes: info.artifactSizeBytes ?? null,
		status: info.status || "unknown",
		startedAt: info.startedAt ?? null,
		completedAt: info.completedAt ?? null,
		failedAt: info.failedAt ?? null,
		lastEventAt: input.lastEventAt ?? null,
		eventCount: input.eventCount ?? 0,
		error: truncated ? `${rawError.slice(0, AUDIT_ERROR_MAX_CHARS)}…` : rawError,
	};
	if (truncated) {
		row.errorTruncated = true;
	}
	return row;
}

/**
 * Append one row. Routed through the per-path queue for the same reason every other database write
 * is: `safeOutputFile`'s temp path is derived from its target, and concurrent writers to one path
 * interleave. Appends must NEVER be coalesced — each row is distinct history, unlike the snapshot
 * writers where collapsing a burst would be harmless.
 */
export async function appendAuditRow(ledgerPath: string, row: AuditRow): Promise<void> {
	const line = `${JSON.stringify(row)}\n`;
	await enqueueWrite(ledgerPath, () => fs.appendFile(ledgerPath, line, "utf8"));
}

/**
 * Read every row, tolerating damage.
 *
 * A malformed line is DROPPED WITH A REPORT rather than aborting the load. Contrast the file this
 * supplements, where one bad byte makes the loader surface zero history and the writer refuse every
 * future write until a human intervenes — the sharpest contradiction of "see every transfer" in the
 * codebase. Here a torn final line (the plausible power-loss shape) costs exactly that line.
 */
export async function loadAuditLedger(ledgerPath: string): Promise<LedgerLoadResult> {
	const result: LedgerLoadResult = { rows: [], skipped: [] };
	let content: string;
	try {
		content = await fs.readFile(ledgerPath, "utf8");
	} catch (err: unknown) {
		if ((err as { code?: string }).code === "ENOENT") {
			return result;
		}
		throw err;
	}

	let byteOffset = 0;
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		const lineStart = byteOffset;
		byteOffset += Buffer.byteLength(line, "utf8") + 1;
		if (!line.trim()) {
			continue;
		}
		try {
			const parsed = JSON.parse(line);
			if (!parsed || typeof parsed !== "object" || typeof parsed.transferId !== "string") {
				result.skipped.push({ lineNumber: i + 1, byteOffset: lineStart, reason: "not an audit row" });
				continue;
			}
			result.rows.push(parsed as AuditRow);
		} catch (err: unknown) {
			result.skipped.push({
				lineNumber: i + 1,
				byteOffset: lineStart,
				reason: (err as Error).message,
			});
		}
	}
	return result;
}

/**
 * Collapse rows to one per transfer.
 *
 * A terminal row always wins over a start row, whatever their positions — see the ORDERING note at
 * the top. Between two rows of the same kind the later one (by position) wins, which is what makes a
 * re-run under a recycled ID show its newest outcome.
 */
export function foldAuditRows(rows: AuditRow[]): Map<string, AuditRow> {
	const folded = new Map<string, AuditRow>();
	for (const row of rows) {
		const existing = folded.get(row.transferId);
		if (!existing) {
			folded.set(row.transferId, row);
			continue;
		}
		if (existing.rowKind === "terminal" && row.rowKind === "start") {
			continue;
		}
		folded.set(row.transferId, row);
	}
	return folded;
}

/** How many terminal rows a transfer has — its revision count, surfaced on the summary. */
export function countRevisions(rows: AuditRow[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const row of rows) {
		if (row.rowKind !== "terminal") {
			continue;
		}
		counts.set(row.transferId, (counts.get(row.transferId) ?? 0) + 1);
	}
	return counts;
}
