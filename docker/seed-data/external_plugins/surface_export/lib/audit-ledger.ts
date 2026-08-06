import fs from "fs/promises";
import { enqueueWrite } from "./persist-queue";
import type { AuditRow, AuditRowKind } from "../shared/dto";

// Re-exported so callers can take the row type from the module that owns the behaviour.
export type { AuditRow, AuditRowKind } from "../shared/dto";

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

export interface LedgerLoadResult {
	rows: AuditRow[];
	/**
	 * Lines that could not be used, with enough detail to find them by hand. `file` names WHICH
	 * generation the damage is in — without it a byte offset is ambiguous once rotation exists.
	 */
	skipped: Array<{ lineNumber: number; byteOffset: number; reason: string; file?: string }>;
}

type RowInput = {
	transferId: string;
	rowKind: AuditRowKind;
	savedAt: number;
	eventCount: number;
	lastEventAt: number | null;
	/**
	 * Every field is optional AND nullable, matching what `buildTransferInfo` actually produces: it
	 * normalises absent values to `null` rather than leaving them undefined. `buildAuditRow` already
	 * collapses both to a default, so the only thing a narrower type would buy is a compile error at
	 * the real call sites.
	 */
	info: {
		operationType?: string | null;
		platformName?: string | null;
		platformIndex?: number | null;
		sourceInstanceId?: number | null;
		sourceInstanceName?: string | null;
		targetInstanceId?: number | null;
		targetInstanceName?: string | null;
		exportId?: string | null;
		artifactSizeBytes?: number | null;
		status?: string | null;
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
export async function appendAuditRow(
	ledgerPath: string,
	row: AuditRow,
	rotation: RotationOptions = {},
): Promise<void> {
	const line = `${JSON.stringify(row)}\n`;
	await enqueueWrite(ledgerPath, async () => {
		// Rotation happens INSIDE the queued unit of work, so a rename can never interleave with an
		// append to the same path — the rotation and the write that follows it are one step as far as
		// any other writer is concerned.
		await rotateIfNeeded(ledgerPath, rotation);
		await fs.appendFile(ledgerPath, line, "utf8");
	});
}

export type RotationOptions = {
	/** Rotate once the live file exceeds this. */
	maxBytes?: number;
	/** How many rotated generations to keep. The oldest beyond this is deleted. */
	maxFiles?: number;
};

/** Live file plus `maxFiles` generations, so the ceiling is (maxFiles + 1) x maxBytes. */
export const DEFAULT_LEDGER_MAX_BYTES = 32 * 1024 * 1024;
export const DEFAULT_LEDGER_MAX_FILES = 8;

/** `…audit.jsonl` → `…audit.1.jsonl`. Generation 1 is the newest rotated file. */
export function generationPath(ledgerPath: string, generation: number): string {
	return ledgerPath.replace(/\.jsonl$/, `.${generation}.jsonl`);
}

/**
 * Roll the live file aside once it exceeds `maxBytes`, shifting existing generations down.
 *
 * Rotation is the ONLY thing in this design that can delete audit history, so the ceiling is stated
 * in bytes rather than left implicit: at the defaults it is 9 x 32 MB ≈ 288 MB, which at the measured
 * ~614 bytes per row is on the order of half a million transfers. "Forever" is honest at that scale,
 * and the config makes it a stated bound rather than a hope.
 *
 * Deliberately size-based, not age-based: the cost this bounds is disk, and rows arrive at whatever
 * rate the cluster transfers. An age rule would delete a quiet cluster's entire history and fail to
 * bound a busy one.
 */
export async function rotateIfNeeded(ledgerPath: string, options: RotationOptions = {}): Promise<boolean> {
	const maxBytes = options.maxBytes ?? DEFAULT_LEDGER_MAX_BYTES;
	const maxFiles = options.maxFiles ?? DEFAULT_LEDGER_MAX_FILES;
	if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
		return false;
	}

	let size: number;
	try {
		({ size } = await fs.stat(ledgerPath));
	} catch (err: unknown) {
		if ((err as { code?: string }).code === "ENOENT") {
			return false;
		}
		throw err;
	}
	if (size < maxBytes) {
		return false;
	}

	// Shift downward from the oldest so a generation is never overwritten while it is still needed.
	// The one beyond maxFiles is dropped — the only deletion of audit history anywhere in this design.
	for (let generation = maxFiles; generation >= 1; generation -= 1) {
		const from = generationPath(ledgerPath, generation);
		if (generation === maxFiles) {
			await fs.rm(from, { force: true });
			continue;
		}
		try {
			await fs.rename(from, generationPath(ledgerPath, generation + 1));
		} catch (err: unknown) {
			if ((err as { code?: string }).code !== "ENOENT") {
				throw err;
			}
		}
	}
	await fs.rename(ledgerPath, generationPath(ledgerPath, 1));
	return true;
}

/**
 * Read every row, tolerating damage.
 *
 * A malformed line is DROPPED WITH A REPORT rather than aborting the load. Contrast the file this
 * supplements, where one bad byte makes the loader surface zero history and the writer refuse every
 * future write until a human intervenes — the sharpest contradiction of "see every transfer" in the
 * codebase. Here a torn final line (the plausible power-loss shape) costs exactly that line.
 */
export async function loadAuditLedger(
	ledgerPath: string,
	options: RotationOptions = {},
): Promise<LedgerLoadResult> {
	const maxFiles = options.maxFiles ?? DEFAULT_LEDGER_MAX_FILES;
	const combined: LedgerLoadResult = { rows: [], skipped: [] };
	// OLDEST generation first, live file last, so file order stays chronological across a rotation
	// boundary and the fold's "later row of the same kind wins" keeps meaning what it means.
	//
	// Reading the generations is not optional: rotation moves rows out of the live file, so a loader
	// that read only that file would drop every rotated transfer out of the index — silently deleting
	// the history this ledger exists to keep, which is the exact failure mode the whole split was
	// built to avoid.
	const paths: string[] = [];
	for (let generation = maxFiles; generation >= 1; generation -= 1) {
		paths.push(generationPath(ledgerPath, generation));
	}
	paths.push(ledgerPath);

	for (const path of paths) {
		const one = await readLedgerFile(path);
		combined.rows.push(...one.rows);
		for (const drop of one.skipped) {
			combined.skipped.push({ ...drop, file: path });
		}
	}
	return combined;
}

async function readLedgerFile(ledgerPath: string): Promise<LedgerLoadResult> {
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
