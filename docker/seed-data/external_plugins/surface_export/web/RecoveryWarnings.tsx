import { Alert } from "antd";
import type { SurfaceExportState } from "./view-models";

export default function RecoveryWarnings({ state }: { state: SurfaceExportState }) {
	const instances = [...(state.tree?.hosts.flatMap(host => host.instances) || []), ...(state.tree?.unassignedInstances || [])];
	const offline = instances.filter(instance => !instance.connected || instance.status !== "running");
	const blocked = instances.filter(instance => !offline.includes(instance) && instance.recovery?.state === "blocked");
	return <>
		{offline.length > 0 && <Alert data-testid="recovery-unverified" style={{ marginBottom: 16 }} type="info" showIcon
			message={`Recovery state unverified on ${offline.length} offline instance${offline.length === 1 ? "" : "s"}`}
			description="Offline platforms have not been checked. This does not establish that a copy is missing." />}
		{blocked.map(instance => <Alert key={instance.instanceId} data-testid="recovery-blocked" style={{ marginBottom: 16 }} type="error" showIcon
			message={`Startup recovery blocked · ${instance.instanceName}`}
			description={instance.recovery?.error || "Transfers from this server are refused until startup recovery completes."} />)}
	</>;
}
