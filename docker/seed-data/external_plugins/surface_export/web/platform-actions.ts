/**
 * The two things you can do to one platform — export it, or read what it is doing — in one place.
 *
 * Both the Manual Transfer table and the gateway canvas's node toolbar offer the same pair of
 * buttons on the same rows. When this lived only in ManualTransferTab, adding the canvas copy would
 * have made two implementations of "export a platform" that could drift apart silently: a changed
 * filename convention or a changed error message in one would leave the other quietly stale.
 *
 * TransferModal is the third caller — it takes `PlatformActionSource` as its input type, so the
 * shape a row hands to a transfer and the shape it hands to an export are the same shape.
 */

import { message as antMessage } from "antd";

import { sanitizeTimestamp, downloadJsonFile, getErrorMessage, getProp } from "./utils";
import type { JsonObject, SurfaceExportPlugin } from "./view-models";

/** One platform, identified well enough to act on. */
export type PlatformActionSource = {
	instanceId: number;
	instanceName: string;
	platformIndex: number;
	platformName: string;
	forceName: string;
};

/**
 * The subset of PlatformModel that `platformStatus` reads.
 *
 * Structural rather than the full model so the canvas can carry only what it draws — a node's data
 * is rebuilt on every tree push, and the tree pushes on every platform status change.
 */
export type PlatformStatusFields = {
	isLocked?: boolean;
	spaceLocation?: string | null;
	currentTarget?: string | null;
	speed?: number;
	transferStatus?: string;
	departureDateMs?: number | null;
	estimatedDurationTicks?: number | null;
};

/**
 * What the platform is DOING. Deliberately not the parked location name: that is already carried by
 * the row's destination icon, so repeating it as text would spend a column on information the row
 * already shows.
 *
 * Ordered most-urgent-first — an in-flight transfer outranks the lock it took out, which outranks
 * ordinary travel.
 *
 * `nowMs` is NULLABLE, and null means "skip the ETA". The countdown needs a 1 s timer, and a caller
 * that renders many of these at once (the canvas, which re-renders every node) must not be made to
 * run one. It loses the "(ETA ~4min)" suffix and keeps everything else.
 */
export function platformStatus(platform: PlatformStatusFields, nowMs: number | null): { text: string; tag?: string } {
	if (platform.transferStatus && platform.transferStatus !== "idle") {
		return { text: platform.transferStatus.replace(/_/g, " "), tag: "processing" };
	}
	if (platform.isLocked) {
		return { text: "locked", tag: "orange" };
	}
	// A set `spaceLocation` means PARKED, and it takes precedence over `currentTarget`: a parked
	// platform retains the target of the journey it already finished, so testing currentTarget first
	// reports a stationary platform as "→ nauvis" forever. Caught by reading the live UI — both
	// parked fixtures claimed to be in flight.
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

/**
 * Export one platform and hand the JSON to the browser as a download.
 *
 * Reports its own success and failure via antd messages rather than throwing, because both call
 * sites want exactly that and a rethrow would only be re-caught to say the same thing twice. The
 * caller's job is the button's loading state, which is why this resolves rather than returning a
 * result nobody reads.
 */
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
