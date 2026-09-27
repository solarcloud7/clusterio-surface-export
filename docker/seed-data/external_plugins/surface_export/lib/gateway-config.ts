import type { Controller } from "@clusterio/controller";
import * as messages from "../messages";
import { getErrorMessage } from "../helpers";
import { timed } from "./timing";
import { instanceAddress } from "./platform-tree";

export class GatewayConfig {
	constructor(
		private readonly controller: Pick<Controller, "config" | "instances" | "hosts" | "sendTo">,
		private readonly logger: messages.IControllerPlugin["logger"],
		private readonly context: {
			isInstanceOnline(instanceId: number): boolean;
			resolveInstanceName(instanceId: number): string | null;
		},
	) {}

	passengerCarry(): messages.PassengerCarry {
		const config = this.controller.config as { get(key: string): unknown };
		return {
			armor: config.get("surface_export.passenger_carry_armor") !== false,
			inventory: config.get("surface_export.passenger_carry_inventory") === true,
		};
	}

	discordInvite(): string {
		const value = (this.controller.config as { get(key: string): unknown }).get("surface_export.discord_invite");
		return typeof value === "string" ? value.trim() : "";
	}

	private targetAddress(instanceId: number): string {
		const inst = this.controller.instances.get(instanceId);
		if (!inst || inst.isDeleted) return "";
		const hostId = Number(inst.config.get("instance.assigned_host"));
		const host = Number.isInteger(hostId) ? this.controller.hosts.get(hostId) : null;
		return instanceAddress(host?.publicAddress, inst.gamePort ?? null);
	}

	private liveInstances() {
		return [...this.controller.instances.values()].filter(inst => !inst.isDeleted);
	}

	destinations(): { destinations: messages.InstanceDestination[] } {
		return {
			destinations: this.liveInstances().map(inst => ({
				gatewayName: messages.instanceGatewayName(inst.id),
				instanceId: inst.id,
				instanceName: this.context.resolveInstanceName(inst.id) ?? String(inst.id),
			})),
		};
	}

	activeGatewayNamesFor(sourceInstanceId: number): string[] {
		const names = [...messages.ONE_GATE_NAMES];
		for (const destination of this.destinations().destinations) {
			if (destination.instanceId !== sourceInstanceId) names.push(destination.gatewayName);
		}
		return names;
	}

	private resolveTarget(instanceId: number, targetGateway: string): messages.ResolvedGatewayTarget {
		return {
			instanceId,
			instanceName: this.context.resolveInstanceName(instanceId) ?? "(unknown)",
			targetGateway,
			online: this.context.isInstanceOnline(instanceId),
			address: this.targetAddress(instanceId),
		};
	}

	private resolveGateways(sourceInstanceId: number): messages.ResolvedGateway[] {
		const others = this.destinations().destinations.filter(destination => destination.instanceId !== sourceInstanceId);
		return [
			{
				gatewayName: messages.ONE_GATE_NAME,
				targets: others.map(destination => this.resolveTarget(destination.instanceId, messages.ONE_GATE_NAME)),
			},
			...others.map(destination => ({
				gatewayName: destination.gatewayName,
				targets: [this.resolveTarget(destination.instanceId, messages.ONE_GATE_NAME)],
			})),
		];
	}

	private async pushGatewayConfigToInstance(sourceInstanceId: number): Promise<string | null> {
		if (!this.context.isInstanceOnline(sourceInstanceId)) {
			return null;
		}
		try {
			const gateways = this.resolveGateways(sourceInstanceId);
			const response = await timed("Clusterio request round trip", "round-trip", () => this.controller.sendTo(
				{ instanceId: sourceInstanceId },
				new messages.PushGatewayConfigRequest({
					gateways,
					activeGatewayNames: this.activeGatewayNamesFor(sourceInstanceId),
					passengerCarry: this.passengerCarry(),
					discordInvite: this.discordInvite(),
				}),
			)) as { success?: boolean; error?: string } | undefined;
			if (!response?.success) {
				const reason = response?.error || "the instance rejected the gateway config";
				this.logger.error(`Instance ${sourceInstanceId} did not apply the gateway config: ${reason}`);
				return reason;
			}
			return null;
		} catch (err: unknown) {
			const reason = getErrorMessage(err);
			this.logger.error(`Failed to push gateway config to instance ${sourceInstanceId}: ${reason}`);
			return reason;
		}
	}

	async pushGatewayConfigToAllSources(): Promise<Map<number, string | null>> {
		const results = new Map<number, string | null>();
		for (const inst of this.liveInstances()) {
			results.set(inst.id, await this.pushGatewayConfigToInstance(inst.id));
		}
		return results;
	}

	async handleGetGatewaysRequest(_request: Record<string, never>) {
		return this.destinations();
	}

	async handleGetGatewayConfigRequest(request: { instanceId: number }) {
		return {
			gateways: this.resolveGateways(Number(request.instanceId)),
			activeGatewayNames: this.activeGatewayNamesFor(Number(request.instanceId)),
			passengerCarry: this.passengerCarry(),
			discordInvite: this.discordInvite(),
		};
	}
}
