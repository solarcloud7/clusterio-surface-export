import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ConflictEntry } from "../shared/lineage-resolution";
import { quarantinedKeys } from "../shared/quarantine-view";
import type { SurfaceExportPlugin, SurfaceExportState } from "./view-models";

export interface LineageConflictsView {
	conflicts: ConflictEntry[];
	unavailable: Array<{ instanceId: number; reason: string }>;
	error: string | null;
	busy: boolean;
	setBusy: (busy: boolean) => void;
	refresh: () => Promise<void>;
}

const EMPTY: ConflictEntry[] = [];
const NONE: Array<{ instanceId: number; reason: string }> = [];

export function useLineageConflicts(plugin: SurfaceExportPlugin, state: SurfaceExportState): LineageConflictsView {
	const [busy, setBusy] = useState(false);
	const refresh = useCallback(async () => { await plugin.refreshQuarantine?.(); }, [plugin]);
	const revision = state.tree ? JSON.stringify(state.tree.hosts.map(host => host.instances.map(instance =>
		[instance.instanceId, instance.connected, instance.status, instance.recovery?.state, instance.platforms.length]))) : "";
	useEffect(() => { void refresh(); }, [refresh, revision]);
	return { conflicts: state.quarantine?.conflicts ?? EMPTY, unavailable: state.quarantine?.unavailable ?? NONE,
		error: state.quarantine?.error ?? null, busy, setBusy, refresh };
}

export const QuarantineContext = createContext<ReadonlySet<string>>(new Set());

export function useQuarantineKeys(conflicts: readonly ConflictEntry[]): ReadonlySet<string> {
	return useMemo(() => quarantinedKeys(conflicts), [conflicts]);
}

export function useIsQuarantined(instanceId: number, platformIndex: number): boolean {
	return useContext(QuarantineContext).has(`${instanceId}:${platformIndex}`);
}
