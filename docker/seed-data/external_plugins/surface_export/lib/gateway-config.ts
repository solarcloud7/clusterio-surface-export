import type { Controller } from "@clusterio/controller";
import * as messages from "../messages";
import { getErrorMessage } from "../helpers";
import { timed } from "./timing";
import { instanceAddress } from "./platform-tree";
import { PortalSlots } from "./portal-slots";
import { portalColour, portalGatewayName, type PortalAssignment } from "../shared/portals";

export class GatewayConfig {
	constructor(
		private readonly controller: Pick<Controller, "config" | "instances" | "hosts" | "sendTo">,
		private readonly logger: messages.IControllerPlugin["logger"],
		private readonly context: {
			isInstanceOnline(instanceId: number): boolean;
			resolveInstanceName(instanceId: number): string | null;
		},
		private readonly slots: PortalSlots = new PortalSlots(logger),
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

	private instanceName(instanceId: number): string {
		return this.context.resolveInstanceName(instanceId) ?? String(instanceId);
	}

	private assignedPortals(): Array<{ slot: number; instanceId: number }> {
		const live = this.liveInstances().map(inst => inst.id);
		this.slots.reconcile(live);
		const liveSet = new Set(live);
		return this.slots.assignments().filter(entry => liveSet.has(entry.instanceId));
	}

	portalOf(instanceId: number): PortalAssignment | null {
		const entry = this.assignedPortals().find(portal => portal.instanceId === instanceId);
		return entry ? { slot: entry.slot, colour: portalColour(entry.slot), label: this.instanceName(instanceId) } : null;
	}

	portals(): messages.PortalListingResponse {
		const portals = this.assignedPortals().map(entry => ({
			slot: entry.slot,
			colour: portalColour(entry.slot),
			gatewayName: portalGatewayName(entry.slot),
			instanceId: entry.instanceId,
			instanceName: this.instanceName(entry.instanceId),
		}));
		const unassigned = this.slots.loadError ? [] : this.slots.unassigned(this.liveInstances().map(inst => inst.id))
			.map(instanceId => ({ instanceId, instanceName: this.instanceName(instanceId) }));
		return this.slots.loadError ? { portals, unassigned, error: this.slots.loadError } : { portals, unassigned };
	}

	activeGatewayNamesFor(sourceInstanceId: number): string[] {
		const names = [...messages.ONE_GATE_NAMES];
		for (const portal of this.assignedPortals()) {
			if (portal.instanceId !== sourceInstanceId) names.push(portalGatewayName(portal.slot));
		}
		return names;
	}

	ownGatewayNameFor(sourceInstanceId: number): string | undefined {
		const own = this.assignedPortals().find(portal => portal.instanceId === sourceInstanceId);
		return own ? portalGatewayName(own.slot) : undefined;
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
		const others = this.liveInstances().filter(inst => inst.id !== sourceInstanceId);
		return [
			{
				gatewayName: messages.ONE_GATE_NAME,
				targets: others.map(inst => this.resolveTarget(inst.id, messages.ONE_GATE_NAME)),
			},
			...this.assignedPortals().filter(portal => portal.instanceId !== sourceInstanceId).map(portal => ({
				gatewayName: portalGatewayName(portal.slot),
				targets: [this.resolveTarget(portal.instanceId, messages.ONE_GATE_NAME)],
			})),
		];
	}

	private configFor(sourceInstanceId: number): messages.GatewayConfigPayload {
		const config: messages.GatewayConfigPayload = {
			gateways: this.resolveGateways(sourceInstanceId),
			activeGatewayNames: this.activeGatewayNamesFor(sourceInstanceId),
			passengerCarry: this.passengerCarry(),
			discordInvite: this.discordInvite(),
		};
		const own = this.ownGatewayNameFor(sourceInstanceId);
		if (own) config.ownGatewayName = own;
		return config;
	}

	private async pushGatewayConfigToInstance(sourceInstanceId: number): Promise<string | null> {
		if (!this.context.isInstanceOnline(sourceInstanceId)) {
			return null;
		}
		try {
			const response = await timed("Clusterio request round trip", "round-trip", () => this.controller.sendTo(
				{ instanceId: sourceInstanceId },
				new messages.PushGatewayConfigRequest(this.configFor(sourceInstanceId)),
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
		return this.portals();
	}

	async handleGetGatewayConfigRequest(request: { instanceId: number }) {
		return this.configFor(Number(request.instanceId));
	}
}
