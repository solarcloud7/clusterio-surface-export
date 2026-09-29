import { Button, Modal, Tooltip, message } from "antd";
import { ReloadOutlined, WarningOutlined } from "@ant-design/icons";
import { useAccount } from "@clusterio/web_ui";
import { PERMISSIONS } from "../messages";
import { newRestoreRequestId } from "../shared/snapshot";
import type { ConflictEntry, ResolutionAction } from "../shared/lineage-resolution";
import { quarantineRow, type QuarantineCopy, type QuarantineRow } from "../shared/quarantine-view";
import type { SurfaceExportPlugin, SurfaceExportState } from "./view-models";
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

const DELETES: ReadonlySet<ResolutionAction> = new Set(["keep_this", "keep_other", "stale_copy"]);

function transferHref(copy: QuarantineCopy): string {
	return copy.transferId
		? `/surface-export?tab=logs&transfer=${encodeURIComponent(copy.transferId)}`
		: `/surface-export?tab=logs&platform=${encodeURIComponent(copy.platformName || "")}`;
}

function CopyCard({ copy, serverName, side }: { copy: QuarantineCopy; serverName: string; side: "left" | "right" }) {
	const name = copy.platformName || "Unnamed platform";
	if (copy.state === "none") {
		return <div className="se-quarantine-copy is-empty" data-testid={`quarantine-${side}`}>
			<div className="se-quarantine-copy-title">No other copy</div>
			<div className="se-quarantine-copy-name">{name}</div>
		</div>;
	}
	const trip = copy.generation === null ? "untracked" : `Trip ${copy.generation}`;
	const note = copy.state === "missing" ? `Not found on ${serverName}` : copy.state === "unknown" ? `${serverName} could not confirm this copy` : null;
	return <div className={`se-quarantine-copy${copy.newer ? " is-newer" : ""}${copy.state === "missing" ? " is-missing" : ""}`} data-testid={`quarantine-${side}`}>
		<div className="se-quarantine-copy-title">{serverName} · <a href={transferHref(copy)} title={copy.transferId ? "Open the last transfer" : "Open this platform's transfer history"}>{trip}</a></div>
		<Tooltip title={note}><div className="se-quarantine-copy-name">{name}{note ? " (not found)" : ""}</div></Tooltip>
	</div>;
}

export default function QuarantinedPlatforms({ plugin, state, view }: {
	plugin: SurfaceExportPlugin; state: SurfaceExportState; view: LineageConflictsView;
}) {
	const account = useAccount();
	const canResolve = account.hasPermission(PERMISSIONS.RECOVERY_RESOLVE) === true;
	const [modal, modalContext] = Modal.useModal();
	const instances = [...(state.tree?.hosts.flatMap(host => host.instances) || []), ...(state.tree?.unassignedInstances || [])];
	const nameOf = (id: number | null) => (id !== null && instances.find(instance => instance.instanceId === id)?.instanceName) || (id === null ? "another server" : `Instance ${id}`);
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
			message.warning(`${label}: no reply (${getErrorMessage(failure, "no reply")}). Retry it from the list; don't start a new one.`, 10);
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

	const confirm = (conflict: ConflictEntry, row: QuarantineRow, action: ResolutionAction) => {
		const requestId = newRestoreRequestId();
		const left = nameOf(row.left.instanceId), right = nameOf(row.right.instanceId);
		const name = conflict.platformName || `Platform ${conflict.platformIndex}`;
		let title: string, body: string, ok: string;
		switch (action) {
			case "keep_this": title = `Keep ${left}'s copy of ${name}?`; body = `${right}'s copy is saved as a snapshot and then deleted.`; ok = "Keep"; break;
			case "keep_other": title = `Keep ${right}'s copy of ${name}?`; body = `${left}'s copy is saved as a snapshot and then deleted.`; ok = "Keep"; break;
			case "stale_copy": title = row.rightKeeps ? `Keep ${right}'s copy of ${name}?` : `Discard ${left}'s copy of ${name}?`;
				body = `${left}'s copy is saved as a snapshot and then deleted.${row.right.state === "present" ? "" : " No other copy was found, so the snapshot is the only one left."}`;
				ok = row.rightKeeps ? "Keep" : "Discard"; break;
			case "adopt": title = `Keep ${left}'s copy of ${name}?`; body = "It becomes the current copy and can travel again."; ok = "Keep"; break;
			case "release": title = `Keep ${left}'s copy of ${name}?`; body = "It is released unchanged and can travel again."; ok = "Keep"; break;
			case "new_platform": title = row.centerAction === "new_platform" ? `Take both copies of ${name}?` : `Keep ${left}'s copy as a new platform?`;
				body = row.centerAction === "new_platform"
					? `${left}'s copy becomes a separate platform. Everything aboard it now exists twice.`
					: "It gets a new platform history and can travel again."; ok = row.centerAction === "new_platform" ? "Take both" : "Keep"; break;
		}
		const aboard = action === "keep_this" ? conflict.holderPassengers : conflict.passengers;
		modal.confirm({
			title, okText: ok, okButtonProps: { danger: DELETES.has(action) || row.centerAction === action },
			content: <div data-testid="lineage-resolution-confirm">
				<p>{body}</p>
				{DELETES.has(action) && aboard ? <p>{aboard} player{aboard === 1 ? "" : "s"} aboard the deleted copy {aboard === 1 ? "is" : "are"} moved to the default planet.</p> : null}
				<details className="se-quarantine-details"><summary>Technical details</summary>
					<p>{VERDICT_TEXT[conflict.liveVerdict] || conflict.liveVerdict}</p>
					{DELETES.has(action) && <p>The snapshot is stored with other exports and is not pinned: normal export cleanup can remove it later.</p>}
					<p>Hints (not proof): {[conflict.hints.journalHubMatch && "hub matches a transferred platform",
						conflict.hints.journalUidMatch && "identity matches a transferred platform",
						conflict.hints.historyMatch && "transfer history names this copy",
						conflict.hints.presence].filter(Boolean).join("; ") || "none"}. Platform names are never used to decide.</p>
					<p>Request {requestId}</p>
				</details>
			</div>,
			onOk: () => submit(conflict, action, requestId, title.replace(/\?$/, "")),
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
			const act = (action: ResolutionAction | null, label: string) => canResolve && action
				? <Button size="small" disabled={busy || !conflict.platformUid} onClick={() => confirm(conflict, row, action)}>{label}</Button>
				: <span className="se-quarantine-slot" />;
			return <div key={row.key} className="se-quarantine-row" data-testid="lineage-conflict" data-verdict={conflict.liveVerdict}>
				{act(row.leftAction, "Keep")}
				<CopyCard copy={row.left} serverName={nameOf(row.left.instanceId)} side="left" />
				<div className="se-quarantine-center">
					{row.resolution ? <span className="se-quarantine-note">Resolving ({row.resolution.step}{row.resolution.error ? `: ${row.resolution.error}` : ""})
						{canResolve && <Button size="small" type="link" disabled={busy}
							onClick={() => void submit(row.resolution!, row.resolution!.action, row.resolution!.requestId, "Retry")}>Retry</Button>}
						{canResolve && row.resolution.status === "in_progress" && <Button size="small" type="link" danger disabled={busy}
							onClick={() => void abandon(row.resolution!.requestId)}>Abandon</Button>}</span>
						: row.centerAction && canResolve ? <Button size="small" disabled={busy || !conflict.platformUid} onClick={() => confirm(conflict, row, row.centerAction!)}>Take both</Button>
						: row.blocked && !row.leftAction && !row.rightAction ? <Tooltip title={row.blocked}><span className="se-quarantine-note">Waiting</span></Tooltip> : null}
				</div>
				<CopyCard copy={row.right} serverName={nameOf(row.right.instanceId)} side="right" />
				{act(row.rightAction, row.rightKeeps ? "Keep" : "Discard")}
			</div>;
		})}
		{unavailable.map(entry => <p key={`unavailable-${entry.instanceId}`} className="se-quarantine-note">{nameOf(entry.instanceId)} was not checked ({entry.reason}).</p>)}
		{error && <p className="se-quarantine-note">{error}</p>}
	</section>;
}
