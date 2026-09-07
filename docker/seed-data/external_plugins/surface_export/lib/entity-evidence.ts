import fs from "node:fs/promises";
import path from "node:path";
import type { EntityEvidence, BeltDifference } from "../shared/entity-evidence";

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ROWS = 500;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
export const unavailableEvidence = (file: string, reason: string): EntityEvidence => ({ status: "unavailable", file, reason, rows: [], totalRows: 0, truncated: false });

export function projectEntityEvidence(value: unknown, transferId: string, file: string, tick: number): EntityEvidence {
	const bundle = object(value);
	if (bundle.transfer_id !== transferId || bundle.gate_tick !== tick) return unavailableEvidence(file, "Diagnostic identity does not match this operation.");
	const lines = object(bundle.belt_lines).rows;
	if (!Array.isArray(lines)) return unavailableEvidence(file, "This diagnostic has no belt-line comparison.");
	const rows: BeltDifference[] = [];
	let totalRows = 0;
	for (const value of lines) {
		const row = object(value), position = object(row.position), expected = object(row.expected), actual = object(row.actual);
		if (!row.expected || typeof row.expected !== "object" || Array.isArray(row.expected)
			|| !row.actual || typeof row.actual !== "object" || Array.isArray(row.actual)) {
			return unavailableEvidence(file, "The diagnostic is missing source or destination counts.");
		}
		if (!finite(row.entity_id) || typeof row.entity_name !== "string" || !finite(position.x) || !finite(position.y) || !finite(row.line_index)) {
			return unavailableEvidence(file, "The diagnostic contains malformed belt measurements.");
		}
		for (const item of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
			const before = expected[item] ?? 0, after = actual[item] ?? 0;
			if (!finite(before) || !finite(after) || before < 0 || after < 0) return unavailableEvidence(file, "The diagnostic contains invalid item counts.");
			if (before === after) continue;
			totalRows++;
			if (rows.length < MAX_ROWS) rows.push({ entityId: row.entity_id, name: row.entity_name,
				x: position.x, y: position.y, line: row.line_index, item, expected: before, actual: after, delta: after - before });
		}
	}
	return { status: "available", file, rows, totalRows, truncated: totalRows > rows.length };
}

export async function readEntityEvidence(directory: string, request: { transferId: string; file: string; tick: number }): Promise<EntityEvidence> {
	const { file, transferId, tick } = request;
	if (!/^failure_black_box_[A-Za-z0-9_-]+_\d+\.json$/.test(file)) return unavailableEvidence(file, "Invalid diagnostic reference.");
	let handle;
	try {
		const root = await fs.realpath(directory), resolved = await fs.realpath(path.join(root, file));
		if (path.dirname(resolved) !== root) return unavailableEvidence(file, "Diagnostic reference is outside script-output.");
		handle = await fs.open(resolved, "r");
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > MAX_BYTES) return unavailableEvidence(file, "Diagnostic exceeds the 64 MiB read limit or is not a file.");
		// Limit the read itself as well as stat: a growing file must not bypass the bound.
		const buffer = Buffer.alloc(stat.size + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > stat.size) return unavailableEvidence(file, "Diagnostic changed while being read; retry after it finishes.");
		return projectEntityEvidence(JSON.parse(buffer.subarray(0, length).toString("utf8")), transferId, file, tick);
	} catch (error) {
		return unavailableEvidence(file, `The diagnostic file is missing, unreadable, or incomplete on the destination host: ${error instanceof Error ? error.message : String(error)}`);
	} finally { await handle?.close(); }
}
