import React, { useEffect, useMemo, useState } from "react";
import {
	Alert,
	Button,
	Card,
	Empty,
	Select,
	Space,
	Spin,
	Tag,
	Tooltip,
	Typography,
	message as antMessage,
} from "antd";

import { DownloadOutlined } from "@ant-design/icons";
import { PlanetIcon } from "./icons";
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
	locationText: string;
};

function locationLabel(platform: PlatformModel, nowMs?: number | null) {
	if (platform.spaceLocation) {
		return platform.spaceLocation;
	}
	if (platform.currentTarget) {
		if (platform.departureDateMs != null && platform.estimatedDurationTicks != null) {
			const totalMs = (platform.estimatedDurationTicks / 60) * 1000;
			const elapsedMs = (nowMs ?? Date.now()) - platform.departureDateMs;
			const remainingMs = Math.max(0, totalMs - elapsedMs);
			const remainingMin = Math.round(remainingMs / 60000);
			return `→ ${platform.currentTarget} (ETA ~${remainingMin}min)`;
		}
		return `→ ${platform.currentTarget}`;
	}
	if (platform.speed && platform.speed > 0) {
		return "in transit";
	}
	return "—";
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
	const [selectedPlatformKey, setSelectedPlatformKey] = useState<string | null>(null);
	const [selectedTargetInstance, setSelectedTargetInstance] = useState<number | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
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
						locationText: locationLabel(platform, nowMs),
					});
				}
			}
		}
		return lookup;
	}, [hostSections, nowMs, tree]);
	const selectedSource = selectedPlatformKey ? platformLookup.get(selectedPlatformKey) : null;

	const destinationOptions = useMemo(() => {
		if (!tree) {
			return [];
		}
		const nodes: InstanceNodeModel[] = [];
		for (const host of tree.hosts || []) {
			for (const instance of host.instances || []) {
				nodes.push(instance);
			}
		}
		for (const instance of tree.unassignedInstances || []) {
			nodes.push(instance);
		}
		return nodes
			.filter(inst => inst.instanceId !== selectedSource?.instanceId)
			.map(inst => ({
				label: inst.instanceName,
				value: inst.instanceId,
			}));
	}, [tree, selectedSource]);

	async function submitTransfer() {
		if (!selectedSource || selectedTargetInstance === null) {
			return;
		}
		setIsSubmitting(true);
		try {
			const response = await plugin.startTransfer({
				sourceInstanceId: selectedSource.instanceId,
				sourcePlatformIndex: selectedSource.platformIndex,
				targetInstanceId: Number(selectedTargetInstance),
				forceName: selectedSource.forceName || "player",
			});
			const responseObj = response as JsonObject;
			if (!getProp(responseObj, "success", false)) {
				throw new Error(String(getProp(responseObj, "error", "Transfer start failed")));
			}
			antMessage.success(`Transfer started: ${getProp(responseObj, "transferId", "")}`, 5);
		} catch (err: unknown) {
			antMessage.error(getErrorMessage(err, "Failed to start transfer"), 10);
		} finally {
			setIsSubmitting(false);
		}
	}

	async function handleExportPlatform(source = selectedSource) {
		if (!source) {
			return;
		}
		setExportingPlatformKey(`platform:${source.instanceId}:${source.platformIndex}`);
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
				<div className="surface-export-tree-panel">
					{loadingTree ? <Spin style={{ margin: "24px auto", display: "block" }} /> : null}
					{treeError ? <Alert type="error" showIcon message={treeError} style={{ marginBottom: 12 }} /> : null}
					{!loadingTree && hostSections.length === 0 ? (
						<Empty description="No instances available" />
					) : null}
					{hostSections.map((section) => {
						const sectionRows = section.instances
							.flatMap(instance =>
								(instance.platforms || [])
									.filter(platform => platform.hasSpaceHub)
									.map(platform => platformLookup.get(`platform:${instance.instanceId}:${platform.platformIndex}`))
									.filter(Boolean) as PlatformRow[]
							)
							.sort((a, b) => a.instanceName.localeCompare(b.instanceName) || a.locationText.localeCompare(b.locationText));
						return (
							<Card
								key={section.key}
								title={<Tag color={section.host?.connected ? "blue" : "default"}>{section.hostName}</Tag>}
								size="small"
								style={{ marginBottom: 12 }}
								styles={{ body: { padding: 0 } }}
							>
							{groupByInstance(sectionRows).map(instanceRows => (
								<div key={`inst:${instanceRows[0].instanceId}`}>
									<div className="surface-export-instance-header">
										<Text strong>{instanceRows[0].instanceName}</Text>
										{instanceRows[0].instance?.platformError ? <Tag color="warning">error</Tag> : null}
									</div>
									{instanceRows.map(row => {
										const moving = !row.platform?.spaceLocation && (row.platform?.currentTarget || (row.platform?.speed || 0) > 0);
										const locationName = row.platform?.spaceLocation || row.platform?.currentTarget;
										return (
											<div
												key={row.key}
												className={row.key === selectedPlatformKey
													? "surface-export-platform-row surface-export-platform-row-selected"
													: "surface-export-platform-row"
												}
												onClick={() => {
													setSelectedPlatformKey(row.key);
													setSelectedTargetInstance(null);
												}}
											>
												<div className="surface-export-platform-row-name">
													<Text>{row.platformName}</Text>
													<Text type="secondary" style={{ fontSize: 11, marginLeft: 4 }}>
														#{row.platformIndex}
													</Text>
													{row.platform?.isLocked ? <Tag color="orange">locked</Tag> : null}
												</div>
												<div className="surface-export-platform-row-location">
													{locationName ? <PlanetIcon name={locationName} size={20} /> : null}
													<Text type={moving ? "secondary" : undefined} italic={moving ? true : undefined}>
														{row.locationText}
													</Text>
												</div>
												<div className="surface-export-platform-row-actions">
													<Tooltip title="Export JSON">
														<Button
															icon={<DownloadOutlined />}
															size="small"
															loading={exportingPlatformKey === row.key}
															onClick={(event: React.MouseEvent<HTMLElement>) => {
																event.stopPropagation();
																handleExportPlatform(row);
															}}
														/>
													</Tooltip>
												</div>
											</div>
										);
									})}
								</div>
							))}
							</Card>
						);
					})}
				</div>

				<div className="surface-export-action-panel">
					<Card title="Manual Transfer">
						<Space direction="vertical" size="middle" style={{ width: "100%" }}>
							{selectedSource ? (
								<Alert
									type="info"
									showIcon
									message={`Source: ${selectedSource.platformName}`}
									description={`${selectedSource.instanceName} — ${selectedSource.locationText}`}
								/>
							) : (
								<Alert type="warning" showIcon message="Select a source platform in the table" />
							)}
							<Select
								placeholder="Select destination instance"
								options={destinationOptions}
								value={selectedTargetInstance}
								onChange={value => setSelectedTargetInstance(value)}
								disabled={!selectedSource}
								style={{ width: "100%" }}
							/>
							<Button
								type="primary"
								onClick={submitTransfer}
								disabled={!selectedSource || selectedTargetInstance === null}
								loading={isSubmitting}
								block
							>
								Start Transfer
							</Button>
						</Space>
					</Card>
				</div>
		</div>
	);
}
