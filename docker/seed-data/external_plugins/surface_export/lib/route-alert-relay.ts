import * as messages from "../messages";
import { getErrorMessage } from "../helpers";

type RelayInstance = { id: number; isDeleted?: boolean; config: { get(key: string): unknown } };

export class RouteAlertRelay {
	private active = new Map<string, { sourceInstanceId: number; alert: messages.RouteAlert }>();

	constructor(
		private readonly controller: {
			instances: Map<number, RelayInstance>;
			sendTo(target: { instanceId: number }, message: messages.RelayRouteAlertRequest): Promise<unknown>;
		},
		private readonly logger: { warn(message: string): void },
		private readonly isInstanceOnline: (instanceId: number) => boolean,
	) {}

	activeAlerts() {
		return [...this.active.values()];
	}

	async accept(sourceInstanceId: number, alert: messages.RouteAlert) {
		const key = `${sourceInstanceId}:${alert.key}`;
		if (alert.active) {
			this.active.set(key, { sourceInstanceId, alert });
		} else {
			this.active.delete(key);
		}
		const targets = [...this.controller.instances.values()]
			.filter(inst => !inst.isDeleted && inst.id !== sourceInstanceId && this.isInstanceOnline(inst.id));
		await Promise.all(targets.map(inst => this.deliver(inst.id, sourceInstanceId, alert)));
	}

	async replayTo(instanceId: number) {
		for (const { sourceInstanceId, alert } of this.active.values()) {
			if (sourceInstanceId !== instanceId) await this.deliver(instanceId, sourceInstanceId, alert);
		}
	}

	private sourceName(instanceId: number) {
		const inst = this.controller.instances.get(instanceId);
		return inst ? String(inst.config.get("instance.name")) : String(instanceId);
	}

	private async deliver(targetInstanceId: number, sourceInstanceId: number, alert: messages.RouteAlert) {
		try {
			const result = await this.controller.sendTo({ instanceId: targetInstanceId },
				new messages.RelayRouteAlertRequest(alert, sourceInstanceId, this.sourceName(sourceInstanceId))) as messages.SimpleResponse | undefined;
			if (result && result.success === false) {
				this.logger.warn(`Instance ${targetInstanceId} refused the route alert from ${sourceInstanceId}: ${result.error ?? "no reason"}`);
			}
		} catch (err: unknown) {
			this.logger.warn(`Route alert relay to instance ${targetInstanceId} failed: ${getErrorMessage(err)}`);
		}
	}
}
