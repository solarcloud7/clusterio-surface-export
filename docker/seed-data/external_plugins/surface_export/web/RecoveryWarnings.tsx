import { Alert } from "antd";
import type { SurfaceExportState } from "./view-models";

export default function RecoveryWarnings({ state }: { state: SurfaceExportState }) {
	const instances = [...(state.tree?.hosts.flatMap(host => host.instances) || []), ...(state.tree?.unassignedInstances || [])];
	return <>{instances.map(instance => {
		if (!instance.connected || instance.status !== "running") return <Alert key={instance.instanceId} data-testid="recovery-unverified"
			style={{marginBottom:16}} type="info" showIcon message={`Recovery state unverified · ${instance.instanceName}`}
			description="This instance is offline. Its platforms have not been checked; this does not establish that a copy is missing." />;
		const notices = instance.recovery?.notices.filter(notice => instance.platforms.some(platform => platform.platformUid === notice.platformUid
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
				</p>)}
			</>} />;
	})}</>;
}
