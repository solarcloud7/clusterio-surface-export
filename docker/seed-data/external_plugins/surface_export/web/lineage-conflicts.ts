import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ConflictEntry } from "../shared/lineage-resolution";
import { quarantinedKeys } from "../shared/quarantine-view";
import type { SurfaceExportPlugin, SurfaceExportState } from "./view-models";
import { getErrorMessage } from "./utils";

const POLL_MS = 30_000;

export interface LineageConflictsView {
	conflicts: ConflictEntry[];
	unavailable: Array<{ instanceId: number; reason: string }>;
	error: string | null;
	busy: boolean;
	setBusy: (busy: boolean) => void;
	refresh: () => Promise<void>;
}

export function useLineageConflicts(plugin: SurfaceExportPlugin, state: SurfaceExportState): LineageConflictsView {
	const [conflicts, setConflicts] = useState<ConflictEntry[]>([]);
	const [unavailable, setUnavailable] = useState<Array<{ instanceId: number; reason: string }>>([]);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const refresh = useCallback(async () => {
		if (!plugin.listLineageConflicts) return;
		try {
			const listing = await plugin.listLineageConflicts();
			setConflicts(listing.conflicts);
			setUnavailable(listing.unavailable);
			setError(null);
		} catch (failure) {
			console.warn("Platform conflicts are unavailable", failure);
			setError(getErrorMessage(failure, "Platform conflicts are unavailable"));
		}
	}, [plugin]);
	const revision = state.tree ? JSON.stringify(state.tree.hosts.map(host => host.instances.map(instance =>
		[instance.instanceId, instance.connected, instance.status, instance.recovery?.state, instance.platforms.length]))) : "";
	useEffect(() => { void refresh(); }, [refresh, revision]);
	useEffect(() => {
		const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, POLL_MS);
		return () => clearInterval(timer);
	}, [refresh]);
	return { conflicts, unavailable, error, busy, setBusy, refresh };
}

export const QuarantineContext = createContext<ReadonlySet<string>>(new Set());

export function useQuarantineKeys(conflicts: readonly ConflictEntry[]): ReadonlySet<string> {
	return useMemo(() => quarantinedKeys(conflicts), [conflicts]);
}

export function useIsQuarantined(instanceId: number, platformIndex: number): boolean {
	return useContext(QuarantineContext).has(`${instanceId}:${platformIndex}`);
}
