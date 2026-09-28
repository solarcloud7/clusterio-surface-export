import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Modal, Space, Tag } from "antd";
import { useAccount } from "@clusterio/web_ui";
import { PERMISSIONS } from "../messages";
import { newRestoreRequestId } from "../shared/snapshot";
import type { ConflictEntry, ResolutionAction } from "../shared/lineage-resolution";
import type { SurfaceExportPlugin, SurfaceExportState } from "./view-models";
import { getErrorMessage } from "./utils";

const ACTION_LABEL: Record<ResolutionAction, string> = {
	keep_this: "Keep this copy",
	keep_other: "Keep the other copy",
	adopt: "Adopt this copy",
	stale_copy: "Delete this copy",
	new_platform: "Treat as a new platform",
	release: "Release after inspection",
};

const VERDICT_TEXT: Record<string, string> = {
	duplicate: "Another server holds the current copy of this platform.",
	rollback_other: "The server recorded as holding the current copy no longer has it.",
	unregistered: "The controller has no record of this transferred platform.",
	stale_self: "This server later received a newer copy of this platform.",
	ahead_of_registry: "This copy is newer than the controller's record.",
	legacy_unclassified: "This platform predates copy tracking and matches a platform this server transferred away.",
	unverified: "The server recorded as holding the current copy cannot confirm it.",
	in_transit: "A transfer of this platform is still unresolved.",
	unresolved_handoff: "An unresolved transfer owns this copy.",
	duplicate_local: "Two platforms on this server carry the same platform history.",
	no_identity: "This platform has no stable hub identity.",
	normal: "The controller's record now matches this copy.",
};

function actionEffect(action: ResolutionAction, conflict: ConflictEntry, holderName: string): string {
	switch (action) {
		case "keep_this": return `The copy on ${holderName} is saved as a snapshot and deleted. This copy becomes the current copy and is released.`;
		case "keep_other": return "This copy is saved as a snapshot and deleted. The copy on the other server stays as it is.";
		case "stale_copy": return "This copy is saved as a snapshot and deleted.";
		case "adopt": return "This copy becomes the current copy and is released. The controller record moves to this server.";
		case "new_platform": return "This copy gets a new platform history and is released. It is no longer linked to the platform it matched.";
		case "release": return conflict.liveVerdict === "no_identity"
			? "This copy is released without a platform history. Inspect it first: it cannot be transferred until it has a hub."
			: "This copy is released unchanged.";
	}
}

export default function LineageConflicts({ plugin, state }: { plugin: SurfaceExportPlugin; state: SurfaceExportState }) {
	const account = useAccount();
	const canResolve = account.hasPermission(PERMISSIONS.RECOVERY_RESOLVE) === true;
	const [modal, modalContext] = Modal.useModal();
	const [conflicts, setConflicts] = useState<ConflictEntry[]>([]);
	const [unavailable, setUnavailable] = useState<Array<{ instanceId: number; reason: string }>>([]);
	const [error, setError] = useState<string | null>(null);
	const [outcome, setOutcome] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const instances = [...(state.tree?.hosts.flatMap(host => host.instances) || []), ...(state.tree?.unassignedInstances || [])];
	const nameOf = (id: number | null) => (id !== null && instances.find(instance => instance.instanceId === id)?.instanceName) || (id === null ? "another server" : `instance ${id}`);

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

	const revision = state.tree ? JSON.stringify(state.tree.hosts.map(host => host.instances.map(instance => [instance.instanceId, instance.recovery?.state]))) : "";
	useEffect(() => { void refresh(); }, [refresh, revision]);

	const submit = async (target: { instanceId: number; platformIndex: number; platformUid: string | null }, action: ResolutionAction, requestId: string) => {
		if (!plugin.resolvePlatformLineage || !target.platformUid) return;
		setBusy(true);
		try {
			const result = await plugin.resolvePlatformLineage({ instanceId: target.instanceId, platformIndex: target.platformIndex,
				platformUid: target.platformUid, action, requestId });
			setOutcome(result.success
				? `${ACTION_LABEL[action]}: ${result.status === "completed" ? "completed" : `in progress (${result.error || result.step}); retry to continue`}. Request ${requestId}.`
				: `${ACTION_LABEL[action]} refused: ${result.error}`);
		} catch (failure) {
			console.warn("Platform resolution reply was lost", failure);
			setOutcome(`${ACTION_LABEL[action]}: the reply was lost (${getErrorMessage(failure, "no reply")}). Retry request ${requestId}; do not start a new one.`);
		} finally {
			setBusy(false);
			await refresh();
		}
	};

	const abandon = async (requestId: string) => {
		if (!plugin.abandonPlatformResolution) return;
		setBusy(true);
		try {
			const result = await plugin.abandonPlatformResolution(requestId);
			setOutcome(result.status === "failed" ? `Resolution ${requestId} abandoned: ${result.error}`
				: `Resolution ${requestId} not abandoned: ${result.error || result.step}`);
		} catch (failure) {
			console.warn("Platform resolution abandon reply was lost", failure);
			setOutcome(`Abandoning resolution ${requestId}: the reply was lost (${getErrorMessage(failure, "no reply")}). Retry the abandon.`);
		} finally {
			setBusy(false);
			await refresh();
		}
	};

	const confirm = (conflict: ConflictEntry, action: ResolutionAction) => {
		const requestId = newRestoreRequestId();
		const deletes = action === "keep_this" || action === "keep_other" || action === "stale_copy";
		const aboard = action === "keep_this" ? conflict.holderPassengers : conflict.passengers;
		modal.confirm({
			title: `${ACTION_LABEL[action]} · ${conflict.platformName || `Platform ${conflict.platformIndex}`} on ${nameOf(conflict.instanceId)}`,
			okText: ACTION_LABEL[action],
			okButtonProps: { danger: deletes },
			content: <div data-testid="lineage-resolution-confirm">
				<p>{actionEffect(action, conflict, nameOf(conflict.holderInstanceId))}</p>
				{deletes && <p>The snapshot is stored with other exports and is not pinned: normal export cleanup can remove it later.</p>}
				{deletes && <p>{aboard === null ? "Players aboard the deleted copy are moved to the default planet."
					: `${aboard} player${aboard === 1 ? "" : "s"} aboard the deleted copy ${aboard === 1 ? "is" : "are"} moved to the default planet.`}</p>}
				<p>Hints (not proof): {[conflict.hints.journalHubMatch && "hub matches a transferred platform",
					conflict.hints.journalUidMatch && "identity matches a transferred platform",
					conflict.hints.historyMatch && "transfer history names this copy",
					conflict.hints.presence].filter(Boolean).join("; ") || "none"}. Platform names are never used to decide.</p>
				<p>Request {requestId}</p>
			</div>,
			onOk: () => submit(conflict, action, requestId),
		});
	};

	if (!conflicts.length && !unavailable.length && !error && !outcome) return null;
	return <Alert data-testid="lineage-conflicts" style={{ marginBottom: 16 }} type="warning" showIcon message="Quarantined platform copies"
		description={<>
			{modalContext}
			{error && <p>{error}</p>}
			{outcome && <p data-testid="lineage-resolution-outcome">{outcome}</p>}
			{unavailable.map(entry => <p key={`unavailable-${entry.instanceId}`}>{nameOf(entry.instanceId)}: not checked ({entry.reason}). This does not mean it has no conflicts.</p>)}
			{conflicts.map(conflict => <div key={`${conflict.instanceId}:${conflict.platformIndex}`} data-testid="lineage-conflict" style={{ marginBottom: 8 }}>
				<Space wrap>
					<strong>{conflict.platformName || `Platform ${conflict.platformIndex}`}</strong>
					<span>on {nameOf(conflict.instanceId)}</span>
					<Tag>{conflict.state}</Tag>
					{conflict.passengers ? <Tag>{conflict.passengers} aboard</Tag> : null}
				</Space>
				<p>{VERDICT_TEXT[conflict.liveVerdict] || conflict.liveVerdict}{conflict.storedReason && conflict.storedReason !== conflict.liveVerdict
					? ` (quarantined as ${conflict.storedReason})` : ""}</p>
				{conflict.blocked && <p>{conflict.blocked}</p>}
				{conflict.resolution && <p>Resolution {conflict.resolution.requestId}: {conflict.resolution.action}, {conflict.resolution.step}
					{conflict.resolution.error ? ` (${conflict.resolution.error})` : ""}
					{canResolve && <Button size="small" type="link" disabled={busy}
						onClick={() => void submit(conflict.resolution!, conflict.resolution!.action, conflict.resolution!.requestId)}>Retry</Button>}
					{canResolve && conflict.resolution.status === "in_progress" && <Button size="small" type="link" danger disabled={busy}
						onClick={() => void abandon(conflict.resolution!.requestId)}>Abandon</Button>}</p>}
				{canResolve && <Space wrap>{conflict.actions.map(action => <Button key={action} size="small" disabled={busy || !conflict.platformUid}
					danger={action === "keep_other" || action === "stale_copy" || action === "keep_this"}
					onClick={() => confirm(conflict, action)}>{ACTION_LABEL[action]}</Button>)}</Space>}
			</div>)}
			<Button size="small" onClick={() => void refresh()} disabled={busy}>Check again</Button>
		</>} />;
}
