import fs from "fs/promises";
import { safeOutputFile } from "@clusterio/lib";
import { enqueueWrite } from "./persist-queue";
import { getErrorMessage, makeCanonicalTransferId, parseCanonicalTransferId } from "../helpers";
import type { IControllerPlugin, StoredExport } from "../messages";

type ExportStorageState = Pick<IControllerPlugin, "logger" | "platformStorage"> & {
	storagePath: string;
	storageLoadError: string | null;
	consecutiveStorageWriteFailures: number;
};

export function canonicalizeStoredExport(state: Pick<ExportStorageState, "logger">, entry: StoredExport): StoredExport {
	const parsed = parseCanonicalTransferId(entry.exportId);
	if (parsed) {
		return { ...entry, exportId: entry.exportId, sourceExportId: entry.sourceExportId || parsed.sourceJobId };
	}
	if (Number.isInteger(Number(entry.instanceId)) && Number(entry.instanceId) > 0) {
		const sourceExportId = entry.sourceExportId || entry.exportId;
		return { ...entry, exportId: makeCanonicalTransferId(Number(entry.instanceId), sourceExportId), sourceExportId };
	}
	state.logger.warn(`Cannot canonicalize stored export ${entry.exportId}: missing numeric instanceId; preserving legacy key`);
	return { ...entry, sourceExportId: entry.sourceExportId || entry.exportId };
}

export async function loadStoredExports(state: ExportStorageState) {
	try {
		const content = await fs.readFile(state.storagePath, "utf8");
		const entries = JSON.parse(content);
		if (Array.isArray(entries)) {
			for (const rawEntry of entries) {
				if (rawEntry && rawEntry.exportId) {
					const entry = rawEntry as StoredExport;
					if (!entry.size && entry.exportData) {
						entry.size = Buffer.byteLength(JSON.stringify(entry.exportData), "utf8");
					}
					const stored = canonicalizeStoredExport(state, entry);
					state.platformStorage.set(stored.exportId, stored);
				}
			}
		}
		state.storageLoadError = null;
		state.logger.info(`Loaded ${state.platformStorage.size} stored platforms from disk`);
	} catch (err: unknown) {
		const code = (err as { code?: string }).code;
		if (code === "ENOENT") {
			state.storageLoadError = null;
			state.logger.verbose("No existing Surface Export storage found; starting fresh");
			return;
		}
		state.storageLoadError = getErrorMessage(err);
		state.logger.error(
			`Stored exports could not be loaded from ${state.storagePath}: ${state.storageLoadError}. `
			+ "Persistence is DISABLED for this session to protect the existing file. To recover: stop the controller, "
			+ `back up ${state.storagePath}, repair or move the file aside, then restart. Stored exports from before this `
			+ "error will reappear after a successful load; exports created while degraded will NOT survive a restart.",
		);
	}
}

export async function persistStoredExports(state: ExportStorageState) {
	if (state.storageLoadError !== null) {
		state.logger.error(
			`Refusing to persist stored exports to ${state.storagePath}: the startup load failed (${state.storageLoadError}) `
			+ "and the file is being preserved as-is. This session's changes will not survive restart. "
			+ "Repair or move the file and restart the controller to re-enable persistence.",
		);
		return;
	}
	try {
		const payload = JSON.stringify(Array.from(state.platformStorage.values()), null, 2);
		await enqueueWrite(state.storagePath, () => safeOutputFile(state.storagePath, payload));
		state.consecutiveStorageWriteFailures = 0;
	} catch (err: unknown) {
		state.consecutiveStorageWriteFailures = (state.consecutiveStorageWriteFailures ?? 0) + 1;
		const run = state.consecutiveStorageWriteFailures;
		const suffix = run > 1
			? ` This is failure #${run} in a row — stored exports have not reached disk since the last `
				+ "success, so nothing created in that window will survive a controller restart. "
				+ "Check free space and permissions on the database directory."
			: "";
		state.logger.error(`Failed to persist Surface Export storage: ${getErrorMessage(err)}.${suffix}`);
	}
}
