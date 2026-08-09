import { message as antMessage } from "antd";

import { sanitizeTimestamp, downloadJsonFile, getErrorMessage, getProp } from "./utils";
import type { JsonObject, SurfaceExportPlugin } from "./view-models";

export type PlatformActionSource = {
	instanceId: number;
	instanceName: string;
	platformIndex: number;
	platformName: string;
	forceName: string;
};

export type PlatformStatusFields = {
	isLocked?: boolean;
	spaceLocation?: string | null;
	currentTarget?: string | null;
	speed?: number;
	transferStatus?: string;
	departureDateMs?: number | null;
	estimatedDurationTicks?: number | null;
};

export function platformStatus(platform: PlatformStatusFields, nowMs: number | null): { text: string; tag?: string } {
	if (platform.transferStatus && platform.transferStatus !== "idle") {
		return { text: platform.transferStatus.replace(/_/g, " "), tag: "processing" };
	}
	if (platform.isLocked) {
		return { text: "locked", tag: "orange" };
	}
	if (platform.spaceLocation) {
		return { text: "parked" };
	}
	if (platform.currentTarget) {
		if (nowMs !== null && platform.departureDateMs != null && platform.estimatedDurationTicks != null) {
			const totalMs = (platform.estimatedDurationTicks / 60) * 1000;
			const remainingMs = Math.max(0, totalMs - (nowMs - platform.departureDateMs));
			return { text: `→ ${platform.currentTarget} (ETA ~${Math.round(remainingMs / 60000)}min)`, tag: "blue" };
		}
		return { text: `→ ${platform.currentTarget}`, tag: "blue" };
	}
	if (platform.speed && platform.speed > 0) {
		return { text: "in transit", tag: "blue" };
	}
	return { text: "—" };
}

export async function exportPlatformToDownload(
	plugin: SurfaceExportPlugin,
	source: PlatformActionSource,
): Promise<void> {
	try {
		const response = await plugin.exportPlatformForDownload({
			sourceInstanceId: source.instanceId,
			sourcePlatformIndex: source.platformIndex,
			forceName: source.forceName || "player",
		}) as JsonObject;
		if (!getProp(response, "success", false)) {
			throw new Error(String(getProp(response, "error", "Export failed")));
		}
		const platformName = String(getProp(response, "platformName", "") || source.platformName || "platform");
		const timestamp = getProp(response, "timestamp", null) as string | number | null;
		const exportData = getProp(response, "exportData", {}) as Record<string, unknown>;
		downloadJsonFile(exportData, `${platformName}_${sanitizeTimestamp(timestamp)}.json`);
		antMessage.success(`Export downloaded: ${getProp(response, "exportId", "")}`, 6);
	} catch (err: unknown) {
		antMessage.error(getErrorMessage(err, "Failed to export platform"), 10);
	}
}
