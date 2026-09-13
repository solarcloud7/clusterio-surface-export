import type { HostNodeModel, InstanceNodeModel } from "./dto";

type InstanceTree = { hosts: HostNodeModel[]; unassignedInstances: InstanceNodeModel[] };
export type DestinationOption = { value: number; label: string; disabled: boolean };

export function destinationOptions(tree: InstanceTree | null, sourceInstanceId?: number): DestinationOption[] {
	if (!tree) return [];
	return [...tree.hosts.flatMap(host => host.instances), ...tree.unassignedInstances]
		.filter(instance => instance.instanceId !== sourceInstanceId)
		.map(instance => ({
			value: instance.instanceId,
			label: instance.gamePort ? `${instance.instanceName} :${instance.gamePort}` : instance.instanceName,
			disabled: !instance.connected || instance.status !== "running",
		}))
		.sort((a, b) => a.label.localeCompare(b.label));
}

export function canSelectDestination(options: DestinationOption[], instanceId: number | null): boolean {
	return options.some(option => option.value === instanceId && !option.disabled);
}
