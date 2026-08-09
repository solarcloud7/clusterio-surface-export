import React, { useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, Empty, Spin, Tag, Tooltip, Typography } from "antd";

import { DownloadOutlined, PlayCircleOutlined } from "@ant-design/icons";
import { PlanetIcon } from "./icons";
import TransferModal from "./TransferModal";
import { exportPlatformToDownload, platformStatus } from "./platform-actions";
import type { PlatformActionSource } from "./platform-actions";
import type { HostNodeModel, InstanceNodeModel, PlatformModel, SurfaceExportPlugin, SurfaceExportState } from "./view-models";

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
	const [transferSource, setTransferSource] = useState<PlatformActionSource | null>(null);
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
			await exportPlatformToDownload(plugin, source);
		} finally {
			setExportingPlatformKey(null);
		}
	}

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
										{}
										{instance?.gamePort ? (
											<Text type="secondary" style={{ fontSize: 12 }}>:{instance.gamePort}</Text>
										) : null}
										{instance?.platformError ? <Tag color="warning">error</Tag> : null}
									</div>
									{instanceRows.map(row => {
										const locationName = row.platform?.spaceLocation || row.platform?.currentTarget;
										const status = platformStatus(row.platform, nowMs);
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
