import { Button, Modal, Tooltip, message } from "antd";
import { ReloadOutlined, WarningOutlined } from "@ant-design/icons";
import { useAccount } from "@clusterio/web_ui";
import { PERMISSIONS } from "../messages";
import { newRestoreRequestId } from "../shared/snapshot";
import type { ConflictEntry, ResolutionAction } from "../shared/lineage-resolution";
import { quarantineRow, tripsLabel, type QuarantineCopy, type QuarantineRow } from "../shared/quarantine-view";
import { formatUptime, uptimeMs } from "../shared/uptime";
import type { InstanceNodeModel, SurfaceExportPlugin, SurfaceExportState } from "./view-models";
import type { LineageConflictsView } from "./lineage-conflicts";
import { getErrorMessage } from "./utils";

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

function transferHref(copy: QuarantineCopy): string {
	return copy.transferId
		? `/surface-export?tab=logs&transfer=${encodeURIComponent(copy.transferId)}`
		: `/surface-export?tab=logs&platform=${encodeURIComponent(copy.platformName || "")}`;
}

function CopyCard({ copy, instance, serverName, side, aboard, reason }: {
	copy: QuarantineCopy; instance: InstanceNodeModel | undefined; serverName: string; side: "left" | "right"; aboard: number | null; reason?: string;
}) {
	const name = copy.platformName || "Unnamed platform";
	if (copy.state === "none") {
		return <div className="se-quarantine-copy is-empty" data-testid={`quarantine-${side}`}>
			<div className="se-quarantine-copy-ship">No other copy</div>
		</div>;
	}
	const online = instance?.status === "running" ? formatUptime(uptimeMs(instance.startedAtMs, Date.now())) : "";
	const where = copy.state === "missing" ? <>not found on <b>{serverName}</b></>
		: copy.state === "unknown" ? <><b>{serverName}</b> could not confirm it</>
			: <>currently on <b>{serverName}</b>{online ? <> · online {online}</> : null}{aboard ? <> · {aboard} aboard</> : null}</>;
	return <div className={`se-quarantine-copy${copy.newer ? " is-newer" : ""}${copy.state === "missing" ? " is-missing" : ""}`}
		data-testid={`quarantine-${side}`} title={reason}>
		<div className="se-quarantine-copy-title">
			<span className="se-quarantine-copy-ship">{name}</span>
			<a className="se-quarantine-copy-trips" href={transferHref(copy)}
				title={copy.transferId ? "Open the last transfer" : "Open this platform's transfer history"}>({tripsLabel(copy.generation)})</a>
		</div>
		<div className="se-quarantine-copy-where">{where}</div>
	</div>;
}

export default function QuarantinedPlatforms({ plugin, state, view }: {
	plugin: SurfaceExportPlugin; state: SurfaceExportState; view: LineageConflictsView;
}) {
	const account = useAccount();
	const canResolve = account.hasPermission(PERMISSIONS.RECOVERY_RESOLVE) === true;
	const [modal, modalContext] = Modal.useModal();
	const instances = [...(state.tree?.hosts.flatMap(host => host.instances) || []), ...(state.tree?.unassignedInstances || [])];
	const instanceOf = (id: number | null) => (id === null ? undefined : instances.find(instance => instance.instanceId === id));
	const nameOf = (id: number | null) => instanceOf(id)?.instanceName || (id === null ? "another server" : `Instance ${id}`);
	const { conflicts, unavailable, error, busy, refresh, setBusy } = view;

	const submit = async (target: { instanceId: number; platformIndex: number; platformUid: string | null }, action: ResolutionAction, requestId: string, label: string) => {
		if (!plugin.resolvePlatformLineage || !target.platformUid) return;
		setBusy(true);
		try {
			const result = await plugin.resolvePlatformLineage({ instanceId: target.instanceId, platformIndex: target.platformIndex,
				platformUid: target.platformUid, action, requestId });
			if (!result.success) message.error(`${label}: refused. ${result.error}`, 10);
			else if (result.status === "completed") message.success(`${label}: done`, 6);
			else message.warning(`${label}: still in progress (${result.error || result.step}). Retry it from the list.`, 10);
		} catch (failure) {
			console.warn("Platform resolution reply was lost", failure);
			message.warning(`${label}: no reply (${getErrorMessage(failure, "no reply")}). Retry it from the list; don't start a new one. Request ${requestId}.`, 10);
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
			if (result.status === "failed") message.success("Resolution abandoned", 6);
			else message.warning(`Not abandoned: ${result.error || result.step}`, 10);
		} catch (failure) {
			console.warn("Platform resolution abandon reply was lost", failure);
			message.warning(`Abandon: no reply (${getErrorMessage(failure, "no reply")}). Retry the abandon.`, 10);
		} finally {
			setBusy(false);
			await refresh();
		}
	};

	const platformLine = (conflict: ConflictEntry, copy: QuarantineCopy) => <p data-testid="lineage-resolution-confirm" className="se-confirm-platform">
		<b>{conflict.platformName || `Platform ${conflict.platformIndex}`}</b> <i>({tripsLabel(copy.generation)})</i>
	</p>;

	const confirmDelete = (conflict: ConflictEntry, action: ResolutionAction, copy: QuarantineCopy) => {
		const requestId = newRestoreRequestId();
		const server = nameOf(copy.instanceId);
		modal.confirm({
			title: `Delete ${server}'s copy?`, okText: "Delete", okButtonProps: { danger: true },
			content: platformLine(conflict, copy),
			onOk: () => submit(conflict, action, requestId, `Delete ${server}'s copy of ${conflict.platformName || `platform ${conflict.platformIndex}`}`),
		});
	};

	const confirmKeep = (conflict: ConflictEntry, row: QuarantineRow) => {
		if (!row.keep) return;
		const requestId = newRestoreRequestId();
		const server = nameOf(row.left.instanceId);
		const duplicates = row.keepBoth && row.keep === "new_platform";
		const label = row.keepBoth ? "Keep both copies" : `Keep ${server}'s copy`;
		modal.confirm({
			title: `${label}?`, okText: row.keepBoth ? "Keep both" : "Keep", okButtonProps: { danger: duplicates },
			content: <>{platformLine(conflict, row.left)}{duplicates && <p>Everything aboard will exist twice.</p>}</>,
			onOk: () => submit(conflict, row.keep!, requestId, `${label} of ${conflict.platformName || `platform ${conflict.platformIndex}`}`),
		});
	};

	if (!conflicts.length && !unavailable.length && !error) return null;
	return <section className="se-quarantine" data-testid="lineage-conflicts" aria-label="Quarantined Platforms">
		{modalContext}
		<header className="se-quarantine-header">
			<WarningOutlined className="se-quarantine-icon" />
			<h3>Quarantined Platforms</h3>
			<Tooltip title="Check again"><Button size="small" type="text" icon={<ReloadOutlined />} aria-label="Check again" disabled={busy} onClick={() => void refresh()} /></Tooltip>
		</header>
		{conflicts.map(conflict => {
			const row = quarantineRow(conflict);
			const remove = (action: ResolutionAction | null, copy: QuarantineCopy) => canResolve && action
				? <Button size="small" danger disabled={busy || !conflict.platformUid} onClick={() => confirmDelete(conflict, action, copy)}>Delete</Button>
				: <span className="se-quarantine-slot" />;
			return <div key={row.key} className="se-quarantine-row" data-testid="lineage-conflict" data-verdict={conflict.liveVerdict}>
				{remove(row.deleteLeft, row.left)}
				<CopyCard copy={row.left} instance={instanceOf(row.left.instanceId)} serverName={nameOf(row.left.instanceId)} side="left"
					aboard={conflict.passengers} reason={VERDICT_TEXT[conflict.liveVerdict] || conflict.liveVerdict} />
				<div className="se-quarantine-center">
					{row.resolution ? <span className="se-quarantine-note">Resolving ({row.resolution.step}{row.resolution.error ? `: ${row.resolution.error}` : ""})
						{canResolve && <Button size="small" type="link" disabled={busy}
							onClick={() => void submit(row.resolution!, row.resolution!.action, row.resolution!.requestId, "Retry")}>Retry</Button>}
						{canResolve && row.resolution.status === "in_progress" && <Button size="small" type="link" danger disabled={busy}
							onClick={() => void abandon(row.resolution!.requestId)}>Abandon</Button>}</span>
						: row.keep && canResolve ? <Button size="small" disabled={busy || !conflict.platformUid} onClick={() => confirmKeep(conflict, row)}>{row.keepBoth ? "Keep both" : "Keep"}</Button>
							: row.blocked && !row.deleteLeft && !row.deleteRight ? <Tooltip title={row.blocked}><span className="se-quarantine-note">Waiting</span></Tooltip> : null}
				</div>
				<CopyCard copy={row.right} instance={instanceOf(row.right.instanceId)} serverName={nameOf(row.right.instanceId)} side="right"
					aboard={conflict.holderPassengers} />
				{remove(row.deleteRight, row.right)}
			</div>;
		})}
		{unavailable.map(entry => <p key={`unavailable-${entry.instanceId}`} className="se-quarantine-note">{nameOf(entry.instanceId)} was not checked ({entry.reason}).</p>)}
		{error && <p className="se-quarantine-note">{error}</p>}
	</section>;
}
