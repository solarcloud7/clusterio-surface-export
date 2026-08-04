import React, { useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, Empty, Spin, Tag, Tooltip, Typography, message as antMessage } from "antd";

import { DownloadOutlined, PlayCircleOutlined } from "@ant-design/icons";
import { PlanetIcon } from "./icons";
import TransferModal from "./TransferModal";
import type { TransferSource } from "./TransferModal";
import { sanitizeTimestamp, downloadJsonFile, getErrorMessage, getProp } from "./utils";
import type { HostNodeModel, InstanceNodeModel, JsonObject, PlatformModel, SurfaceExportPlugin, SurfaceExportState } from "./view-models";

const { Text } = Typography;

type PlatformRow = {
	key: string;
	host: HostNodeModel | null;
	hostName: string;
	instance: InstanceNodeModel;
	instanceId: number;
	instanceName: string;
	platform: PlatformModel;
	platformIndex: number;
	platformName: string;
	forceName: string;
};

/**
 * What the platform is DOING, for the status column. Deliberately not the parked location name:
 * that is already carried by the row's destination icon, so repeating it as text would spend a
 * column on information the row already shows.
 *
 * Ordered most-urgent-first — an in-flight transfer outranks the lock it took out, which outranks
 * ordinary travel.
 */
function statusLabel(platform: PlatformModel, nowMs: number): { text: string; tag?: string } {
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
		if (platform.departureDateMs != null && platform.estimatedDurationTicks != null) {
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

function buildHostSections(tree: SurfaceExportState["tree"]) {
	const sections: Array<{ key: string; host: HostNodeModel | null; hostName: string; instances: InstanceNodeModel[] }> = [];
	for (const host of [...(tree?.hosts || [])].sort((a, b) => String(a.hostName || "").localeCompare(String(b.hostName || "")))) {
		const instances = [...(host.instances || [])].sort((a, b) => String(a.instanceName || "").localeCompare(String(b.instanceName || "")));
		sections.push({
			key: `host:${host.hostId}`,
			host,
			hostName: host.hostName,
			instances,
		});
	}

	const unassignedInstances = [...(tree?.unassignedInstances || [])].sort((a, b) =>
		String(a.instanceName || "").localeCompare(String(b.instanceName || "")),
	);
	if (unassignedInstances.length) {
		sections.push({
			key: "host:unassigned",
			host: null,
			hostName: "Unassigned",
			instances: unassignedInstances,
		});
	}
	return sections;
}

export default function ManualTransferTab({ plugin, state }: { plugin: SurfaceExportPlugin; state: SurfaceExportState }) {
	const [transferSource, setTransferSource] = useState<TransferSource | null>(null);
	const [nowMs, setNowMs] = useState(Date.now());
	const [exportingPlatformKey, setExportingPlatformKey] = useState<string | null>(null);

	useEffect(() => {
		const id = setInterval(() => setNowMs(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);

	const { tree, loadingTree, treeError } = state;

	const hostSections = useMemo(() => buildHostSections(tree), [tree]);
	const platformLookup = useMemo(() => {
		const lookup = new Map<string, PlatformRow>();
		for (const section of hostSections) {
			for (const instance of section.instances) {
				for (const platform of instance.platforms || []) {
					if (!platform.hasSpaceHub) {
						continue;
					}
					const key = `platform:${instance.instanceId}:${platform.platformIndex}`;
					lookup.set(key, {
						key,
						host: section.host,
						hostName: section.hostName,
						instance,
						instanceId: instance.instanceId,
						instanceName: instance.instanceName,
						platform,
						platformIndex: platform.platformIndex,
						platformName: platform.platformName,
						forceName: platform.forceName || tree?.forceName || "player",
					});
				}
			}
		}
		return lookup;
	}, [hostSections, tree]);

	async function handleExportPlatform(source: PlatformRow) {
		setExportingPlatformKey(source.key);
		try {
			const response = await plugin.exportPlatformForDownload({
				sourceInstanceId: source.instanceId,
				sourcePlatformIndex: source.platformIndex,
				forceName: source.forceName || tree?.forceName || "player",
			});
			const responseObj = response as JsonObject;
			if (!getProp(responseObj, "success", false)) {
				throw new Error(String(getProp(responseObj, "error", "Export failed")));
			}
			const platformName = String(getProp(responseObj, "platformName", "") || source.platformName || "platform");
			const timestamp = getProp(responseObj, "timestamp", null) as string | number | null;
			const filename = `${platformName}_${sanitizeTimestamp(timestamp)}.json`;
			const exportData = getProp(responseObj, "exportData", {}) as Record<string, unknown>;
			downloadJsonFile(exportData, filename);
			antMessage.success(`Export downloaded: ${getProp(responseObj, "exportId", "")}`, 6);
		} catch (err: unknown) {
			antMessage.error(getErrorMessage(err, "Failed to export platform"), 10);
		} finally {
			setExportingPlatformKey(null);
		}
	}

	// Group rows by instance, preserving encounter order. Pure: allocates its own Map per call.
	function groupByInstance(rows: PlatformRow[]): PlatformRow[][] {
		const groups = new Map<number, PlatformRow[]>();
		for (const row of rows) {
			const list = groups.get(row.instanceId);
			if (list) list.push(row);
			else groups.set(row.instanceId, [row]);
		}
		return Array.from(groups.values());
	}

	return (
		<div className="surface-export-tab-body">
			{loadingTree ? <Spin style={{ margin: "24px auto", display: "block" }} /> : null}
			{treeError ? <Alert type="error" showIcon message={treeError} style={{ marginBottom: 12 }} /> : null}
			{!loadingTree && hostSections.length === 0 ? <Empty description="No instances available" /> : null}

			{hostSections.map((section) => {
				const sectionRows = section.instances
					.flatMap(instance =>
						(instance.platforms || [])
							.filter(platform => platform.hasSpaceHub)
							.map(platform => platformLookup.get(`platform:${instance.instanceId}:${platform.platformIndex}`))
							.filter(Boolean) as PlatformRow[]
					)
					.sort((a, b) => a.instanceName.localeCompare(b.instanceName) || a.platformName.localeCompare(b.platformName));
				return (
					<Card
						key={section.key}
						title={<Tag color={section.host?.connected ? "blue" : "default"}>{section.hostName}</Tag>}
						size="small"
						style={{ marginBottom: 12 }}
						styles={{ body: { padding: 0 } }}
					>
						{groupByInstance(sectionRows).map(instanceRows => {
							const instance = instanceRows[0].instance;
							return (
								<div key={`inst:${instanceRows[0].instanceId}`}>
									<div className="surface-export-instance-header">
										<Text strong>{instanceRows[0].instanceName}</Text>
										{/* The port disambiguates instances whose names differ only by a digit. Absent
										    until the instance has started, since that is when a port is assigned. */}
										{instance?.gamePort ? (
											<Text type="secondary" style={{ fontSize: 12 }}>:{instance.gamePort}</Text>
										) : null}
										{instance?.platformError ? <Tag color="warning">error</Tag> : null}
									</div>
									{instanceRows.map(row => {
										// The icon shows where the platform IS, or where it is heading while in flight.
										const locationName = row.platform?.spaceLocation || row.platform?.currentTarget;
										const status = statusLabel(row.platform, nowMs);
										return (
											<div key={row.key} className="surface-export-platform-row">
												<div className="surface-export-platform-row-name">
													{locationName
														? <PlanetIcon name={locationName} size={20} title={locationName} />
														: <span className="surface-export-icon-placeholder" />}
													<Text>{row.platformName}</Text>
													<Text type="secondary" style={{ fontSize: 11 }}>#{row.platformIndex}</Text>
												</div>
												<div className="surface-export-platform-row-status">
													{status.tag
														? <Tag color={status.tag}>{status.text}</Tag>
														: <Text type="secondary">{status.text}</Text>}
												</div>
												<div className="surface-export-platform-row-actions">
													<Tooltip title="Export JSON">
														<Button
															icon={<DownloadOutlined />}
															size="small"
															loading={exportingPlatformKey === row.key}
															onClick={() => handleExportPlatform(row)}
														/>
													</Tooltip>
													<Tooltip title="Transfer to another instance">
														<Button
															icon={<PlayCircleOutlined />}
															size="small"
															type="primary"
															onClick={() => setTransferSource({
																instanceId: row.instanceId,
																instanceName: row.instanceName,
																platformIndex: row.platformIndex,
																platformName: row.platformName,
																forceName: row.forceName,
															})}
														/>
													</Tooltip>
												</div>
											</div>
										);
									})}
								</div>
							);
						})}
					</Card>
				);
			})}

			<TransferModal
				source={transferSource}
				onClose={() => setTransferSource(null)}
				plugin={plugin}
				state={state}
			/>
		</div>
	);
}
