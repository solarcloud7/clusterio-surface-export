import { useState } from "react";
import { Alert, Button } from "antd";
import type { SurfaceExportState } from "./view-models";

export default function RecoveryWarnings({ state }: { state: SurfaceExportState }) {
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
	return <>{offline.length > 0 && <Alert data-testid="recovery-unverified" style={{marginBottom:16}} type="info" showIcon
		message={`Recovery state unverified on ${offline.length} offline instance${offline.length === 1 ? "" : "s"}`}
		description="Offline platforms have not been checked. This does not establish that a copy is missing." />}
	{instances.map(instance => {
		if (offline.includes(instance)) return null;
		const noticeKey = (uid: string) => `${instance.instanceId}:${uid}`;
		const notices = instance.recovery?.notices.filter(notice => (notice.status !== "accepted" || !acknowledged.includes(noticeKey(notice.platformUid)))
			&& instance.platforms.some(platform => platform.platformUid === notice.platformUid
				|| (platform.platformIndex === notice.platformIndex && !platform.platformUid))) || [];
		if (!notices.length && instance.recovery?.state !== "blocked") return null;
		return <Alert key={instance.instanceId} data-testid="save-recovery-warning" style={{marginBottom:16}} type="warning" showIcon message={`Loaded-save recovery · ${instance.instanceName}`}
			description={<>
				{instance.recovery?.error && <p>{instance.recovery.error}</p>}
				{notices.map(notice => <p key={notice.platformUid}>
					<a href={`/instances/${instance.instanceId}/view`}>{notice.platformName || `Platform ${notice.platformIndex}`}</a>: {!instance.platforms.some(platform => platform.platformUid === notice.platformUid)
						? "Platform identity is unverified. Review this instance before restoring another copy."
						: notice.status === "accepted"
						? "Save game mode accepted this restored copy. Another copy may exist on another instance."
						: "This restored source remains protected. Review its previous transfer before choosing which copy to keep."}{" "}
					<a href={`/surface-export?tab=logs&transfer=${encodeURIComponent(`${instance.instanceId}:${notice.exportId}`)}`}>View transfer</a>
					{notice.status === "accepted" && instance.platforms.some(platform => platform.platformUid === notice.platformUid)
						&& <Button size="small" type="link" onClick={() => acknowledge(noticeKey(notice.platformUid))}>Acknowledge</Button>}
				</p>)}
			</>} />;
	})}</>;
}
