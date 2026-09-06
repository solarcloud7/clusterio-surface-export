import { safeOutputFile } from "@clusterio/lib";
import { enqueueWrite } from "./persist-queue";
import { appendAuditRow, buildAuditRow, foldAuditRows, countRevisions, loadAuditLedger } from "./audit-ledger";
import type { AuditRow } from "./audit-ledger";
import { getErrorMessage } from "../helpers";
import type { IControllerPlugin } from "../messages";

type ControllerAuditState = Pick<IControllerPlugin,
	"logger" | "auditLedgerPath" | "auditIndex" | "auditRevisions" | "persistedTransactionLogs">;

export async function loadControllerAudit(state: ControllerAuditState) {
	try {
		let { rows, skipped } = await loadAuditLedger(state.auditLedgerPath);
		if (!rows.length && state.persistedTransactionLogs.length) {
			rows = await migrateControllerAudit(state);
		}
		for (const drop of skipped) {
			state.logger.warn(
				`Audit ledger: skipped unreadable line ${drop.lineNumber} at byte ${drop.byteOffset} `
				+ `(${drop.reason}). Every other row was loaded.`,
			);
		}
		state.auditIndex = foldAuditRows(rows);
		state.auditRevisions = countRevisions(rows);
		state.logger.info(
			`Audit ledger: ${state.auditIndex.size} transfer(s) from ${rows.length} row(s)`
			+ (skipped.length ? `, ${skipped.length} unreadable line(s) skipped` : ""),
		);
	} catch (err: unknown) {
		state.auditIndex = new Map();
		state.auditRevisions = new Map();
		state.logger.error(
			`Audit ledger at ${state.auditLedgerPath} could not be read (${getErrorMessage(err)}). `
			+ "The LIST falls back to the detail store, so history is limited to the retention window "
			+ "(transaction_log_detail_entries) instead of every transfer ever run, until this is fixed "
			+ "and the controller restarts. New transfers are still recorded. NOTE: the most likely "
			+ "cause is not a read at all — migrateAuditLedger WRITES inside this same block, and "
			+ "loadAuditLedger already tolerates a missing file and damaged lines on its own.",
		);
	}
}

export async function migrateControllerAudit(state: ControllerAuditState): Promise<AuditRow[]> {
	const rows = [...state.persistedTransactionLogs]
		.sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0))
		.map(entry => {
			const events = Array.isArray(entry.events) ? entry.events : [];
			const lastEvent = events.length ? events[events.length - 1] : null;
			return buildAuditRow({
				transferId: entry.transferId,
				rowKind: "terminal",
				savedAt: entry.savedAt || 0,
				eventCount: events.length,
				lastEventAt: lastEvent?.timestampMs ?? null,
				info: entry.transferInfo || {},
			});
		});
	const payload = rows.map(row => `${JSON.stringify(row)}
`).join("");
	await enqueueWrite(state.auditLedgerPath, () => safeOutputFile(state.auditLedgerPath, payload));
	state.logger.info(
		`Audit ledger: migrated ${rows.length} transfer(s) from the detail store into `
		+ `${state.auditLedgerPath}. The detail store was not modified. NOTE: that store is a BOUNDED `
		+ "window (transaction_log_detail_entries), so this migration recovers only the transfers "
		+ "still inside it. Any older than the window are not represented — this is the full set the "
		+ "controller still holds, not necessarily the full set that ever ran.",
	);
	return rows;
}

export async function recordControllerAuditRow(state: ControllerAuditState, row: AuditRow) {
	try {
		await appendAuditRow(state.auditLedgerPath, row);
		const existing = state.auditIndex.get(row.transferId);
		if (!(existing && existing.rowKind === "terminal" && row.rowKind === "start")) {
			state.auditIndex.set(row.transferId, row);
		}
		if (row.rowKind === "terminal") {
			state.auditRevisions.set(row.transferId, (state.auditRevisions.get(row.transferId) ?? 0) + 1);
		}
	} catch (err: unknown) {
		state.logger.error(
			`Audit ledger: failed to record ${row.rowKind} row for ${row.transferId} `
			+ `(${getErrorMessage(err)}). The transfer itself is unaffected and its detail entry is `
			+ "intact, but this transfer now has NO permanent audit row — it will disappear from the "
			+ `history when its detail entry ages out of the retention window. Check that `
			+ `${state.auditLedgerPath} is writable.`,
		);
	}
}
