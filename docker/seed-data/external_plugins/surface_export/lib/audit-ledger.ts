import fs from "fs/promises";
import { enqueueWrite } from "./persist-queue";
import type { AuditRow, AuditRowKind } from "../shared/dto";

export type { AuditRow, AuditRowKind } from "../shared/dto";


export const AUDIT_ROW_VERSION = 1;

export const AUDIT_ERROR_MAX_CHARS = 512;

export interface LedgerLoadResult {
	rows: AuditRow[];
	skipped: Array<{ lineNumber: number; byteOffset: number; reason: string; file?: string }>;
}

type RowInput = {
	transferId: string;
	rowKind: AuditRowKind;
	savedAt: number;
	eventCount: number;
	lastEventAt: number | null;
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
		observedDurationMs?: number | null;
		completedAt?: number | null;
		failedAt?: number | null;
		error?: string | null;
	};
};

export function buildAuditRow(input: RowInput): AuditRow {
	const info = input.info || {};
	const rawError = info.error ?? null;
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
	if (info.observedDurationMs !== undefined) row.observedDurationMs = info.observedDurationMs;
	return row;
}

export async function appendAuditRow(
	ledgerPath: string,
	row: AuditRow,
	rotation: RotationOptions = {},
): Promise<void> {
	const line = `${JSON.stringify(row)}\n`;
	await enqueueWrite(ledgerPath, async () => {
		await rotateIfNeeded(ledgerPath, rotation);
		await fs.appendFile(ledgerPath, line, "utf8");
	});
}

export type RotationOptions = {
	maxBytes?: number;
	maxFiles?: number;
};

export const DEFAULT_LEDGER_MAX_BYTES = 32 * 1024 * 1024;
export const DEFAULT_LEDGER_MAX_FILES = 8;

export function generationPath(ledgerPath: string, generation: number): string {
	return ledgerPath.replace(/\.jsonl$/, `.${generation}.jsonl`);
}

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

export async function loadAuditLedger(
	ledgerPath: string,
	options: RotationOptions = {},
): Promise<LedgerLoadResult> {
	const maxFiles = options.maxFiles ?? DEFAULT_LEDGER_MAX_FILES;
	const combined: LedgerLoadResult = { rows: [], skipped: [] };
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
