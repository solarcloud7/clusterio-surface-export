import type { Controller } from "@clusterio/controller";
import * as messages from "../messages";
import { getErrorMessage } from "../helpers";
import { timed } from "./timing";
import { instanceAddress } from "./platform-tree";
import { PortalSlots, type PortalHolderChange } from "./portal-slots";
import { PORTAL_COLOURS, PORTAL_SLOT_COUNT, portalColour, portalGatewayName, type PortalAssignment } from "../shared/portals";

function colourName(colour: string): string {
	return colour.charAt(0).toUpperCase() + colour.slice(1);
}

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
		return [...this.controller.instances.values()]
			.filter(inst => !inst.isDeleted && inst.config.get("surface_export.load_plugin") !== false);
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

	async settle(): Promise<void> {
		await this.slots.settle(this.liveInstances().map(inst => inst.id));
	}

	portalOf(instanceId: number): PortalAssignment | null {
		const entry = this.assignedPortals().find(portal => portal.instanceId === instanceId);
		return entry ? { slot: entry.slot, colour: portalColour(entry.slot), label: this.instanceName(instanceId) } : null;
	}

	private warnHolderChanges(changes: PortalHolderChange[]) {
		for (const change of changes) {
			this.logger.warn(`The ${colourName(portalColour(change.slot))} portal now leads to ${this.instanceName(change.instanceId)} `
				+ `(instance ${change.instanceId}) instead of ${this.instanceName(change.previousInstanceId)} (instance ${change.previousInstanceId}); `
				+ "schedules that stop there now travel to the new server");
		}
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
		const retired = this.slots.loadError ? [] : this.slots.retired().map(entry => ({
			slot: entry.slot,
			colour: portalColour(entry.slot),
			gatewayName: portalGatewayName(entry.slot),
			formerInstanceId: entry.previousInstanceId,
			formerInstanceName: this.instanceName(entry.previousInstanceId),
		}));
		return this.slots.loadError ? { portals, unassigned, retired, error: this.slots.loadError } : { portals, unassigned, retired };
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
		await this.settle();
		const results = new Map<number, string | null>();
		for (const inst of this.liveInstances()) {
			results.set(inst.id, await this.pushGatewayConfigToInstance(inst.id));
		}
		return results;
	}

	private resolvePortal(value: string): number {
		const text = String(value).trim().toLowerCase();
		const slot = /^[1-9]$/.test(text) ? Number(text) : PORTAL_COLOURS.indexOf(text as typeof PORTAL_COLOURS[number]) + 1;
		if (!(slot >= 1 && slot <= PORTAL_SLOT_COUNT)) {
			throw new Error(`Unknown portal '${value}': use 1-${PORTAL_SLOT_COUNT} or ${PORTAL_COLOURS.join(", ")}`);
		}
		return slot;
	}

	private resolveServer(value: string): number {
		const text = String(value).trim();
		const all = [...this.controller.instances.values()].filter(inst => !inst.isDeleted);
		const byId = /^-?\d+$/.test(text) ? all.filter(inst => inst.id === Number(text)) : [];
		const matches = byId.length ? byId : all.filter(inst => this.context.resolveInstanceName(inst.id) === text);
		if (matches.length === 0) throw new Error(`Unknown instance '${value}'`);
		if (matches.length > 1) throw new Error(`Instance name '${value}' is shared by several instances; use the instance id`);
		const inst = matches[0];
		if (inst.config.get("surface_export.load_plugin") === false) {
			throw new Error(`Instance '${value}' does not load the surface_export plugin, so it cannot hold a portal`);
		}
		return inst.id;
	}

	async handleSetPortalRequest(request: { action: "assign" | "release"; portal: string; instance?: string }) {
		const slot = this.resolvePortal(request.portal);
		await this.settle();
		const name = colourName(portalColour(slot));
		if (request.action === "assign") {
			if (request.instance === undefined) throw new Error("assign needs an instance");
			const instanceId = this.resolveServer(request.instance);
			this.warnHolderChanges(await this.slots.assign(slot, instanceId));
			this.logger.info(`The ${name} portal was assigned to ${this.instanceName(instanceId)} (instance ${instanceId}) by an administrator`);
		} else {
			const former = await this.slots.release(slot);
			this.logger.warn(`The ${name} portal no longer leads to ${this.instanceName(former)} (instance ${former}); `
				+ "it stays locked until an administrator assigns it");
		}
		for (const [sourceInstanceId, error] of await this.pushGatewayConfigToAllSources()) {
			if (error) this.logger.warn(`Portal change could not reach instance ${sourceInstanceId}: ${error}`);
		}
		return this.portals();
	}

	async handleGetGatewaysRequest(_request: Record<string, never>) {
		await this.settle();
		return this.portals();
	}

	async handleGetGatewayConfigRequest(request: { instanceId: number }) {
		await this.settle();
		return this.configFor(Number(request.instanceId));
	}
}
