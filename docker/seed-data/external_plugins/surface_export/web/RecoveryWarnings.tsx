import { useState } from "react";
import { Alert, Button } from "antd";
import type { SurfaceExportPlugin, SurfaceExportState } from "./view-models";
import LineageConflicts from "./LineageConflicts";
import type { RecoveryNotice } from "../shared/recovery";

const QUARANTINE_TEXT: Record<string, string> = {
	legacy_unclassified: "This platform predates copy tracking and matches a platform this server already transferred away. It stays quarantined until an administrator chooses which copy to keep.",
	duplicate: "Another server holds the current copy of this platform. This copy stays quarantined.",
	unverified: "The server recorded as holding the current copy could not confirm it. This copy stays quarantined; an offline or restarting server does not prove that a copy is missing.",
	rollback_other: "The server recorded as holding the current copy no longer has it. This restored copy stays quarantined for review.",
	stale_self: "This server later received a newer copy of this platform. This older copy stays quarantined.",
	ahead_of_registry: "This copy is newer than the controller's record of the platform. It stays quarantined for review.",
	unregistered: "The controller has no record of this transferred platform. It stays quarantined.",
	in_transit: "A transfer of this platform is still unresolved. This copy stays quarantined.",
	duplicate_local: "Two platforms on this server carry the same platform history. Both stay quarantined.",
	unresolved_handoff: "An unresolved transfer owns this source platform. It stays quarantined.",
	no_identity: "This platform has no stable hub identity. It stays quarantined.",
	reconcile_error: "Recovery could not verify this platform. It stays quarantined.",
};

function noticeText(notice: RecoveryNotice, identified: boolean): string {
	if (!identified) return "Platform identity is unverified. Review this instance before restoring another copy.";
	if (notice.status === "accepted") {
		return notice.reason === "rollback_other"
			? "Save game mode accepted this restored copy because the server recorded as holding the current copy no longer has it."
			: "Save game mode accepted this restored copy. Another copy may exist on another instance.";
	}
	if (notice.status === "quarantined") return QUARANTINE_TEXT[notice.reason || ""] || QUARANTINE_TEXT.reconcile_error;
	return "This restored source remains protected. Review its previous transfer before choosing which copy to keep.";
}

export default function RecoveryWarnings({ state, plugin }: { state: SurfaceExportState; plugin?: SurfaceExportPlugin }) {
	const [acknowledged, setAcknowledged] = useState<string[]>(() => {
		try {
			const value = JSON.parse(localStorage.getItem("surface-export.recovery-acknowledged") || "[]");
			return Array.isArray(value) ? value.filter(key => typeof key === "string") : [];
		} catch (error) { console.warn("Unable to read recovery acknowledgements", error); return []; }
	});
	const acknowledge = (key: string) => {
		const next = [...acknowledged.filter(value => value !== key), key].slice(-200);
		setAcknowledged(next);
		try { localStorage.setItem("surface-export.recovery-acknowledged", JSON.stringify(next)); }
		catch (error) { console.warn("Unable to save recovery acknowledgement", error); }
	};
	const instances = [...(state.tree?.hosts.flatMap(host => host.instances) || []), ...(state.tree?.unassignedInstances || [])];
	const offline = instances.filter(instance => !instance.connected || instance.status !== "running");
	return <>{plugin && <LineageConflicts plugin={plugin} state={state} />}{offline.length > 0 && <Alert data-testid="recovery-unverified" style={{marginBottom:16}} type="info" showIcon
		message={`Recovery state unverified on ${offline.length} offline instance${offline.length === 1 ? "" : "s"}`}
		description="Offline platforms have not been checked. This does not establish that a copy is missing." />}
	{instances.map(instance => {
		if (offline.includes(instance)) return null;
		const noticeKey = (uid: string) => `${instance.instanceId}:${uid}`;
		const identified = (notice: RecoveryNotice) => Boolean(notice.platformUid)
			&& instance.platforms.some(platform => platform.platformUid === notice.platformUid);
		const notices = instance.recovery?.notices.filter(notice => (notice.status !== "accepted" || !notice.platformUid || !acknowledged.includes(noticeKey(notice.platformUid)))
			&& instance.platforms.some(platform => (notice.platformUid && platform.platformUid === notice.platformUid)
				|| (platform.platformIndex === notice.platformIndex && (!platform.platformUid || !notice.platformUid)))) || [];
		if (!notices.length && instance.recovery?.state !== "blocked") return null;
		return <Alert key={instance.instanceId} data-testid="save-recovery-warning" style={{marginBottom:16}} type="warning" showIcon message={`Loaded-save recovery · ${instance.instanceName}`}
			description={<>
				{instance.recovery?.error && <p>{instance.recovery.error}</p>}
				{notices.map(notice => <p key={`${notice.platformIndex}:${notice.platformUid ?? ""}`}>
					<a href={`/instances/${instance.instanceId}/view`}>{notice.platformName || `Platform ${notice.platformIndex}`}</a>: {noticeText(notice, identified(notice) || (!notice.platformUid && notice.status === "quarantined"))}{" "}
					{notice.exportId && <a href={`/surface-export?tab=logs&transfer=${encodeURIComponent(`${instance.instanceId}:${notice.exportId}`)}`}>View transfer</a>}
					{notice.status === "accepted" && notice.platformUid && identified(notice)
						&& <Button size="small" type="link" onClick={() => acknowledge(noticeKey(notice.platformUid as string))}>Acknowledge</Button>}
				</p>)}
			</>} />;
	})}</>;
}
