import React, { useMemo, useState } from "react";
import {
	Alert,
	Button,
	Card,
	Empty,
	Select,
	Space,
	Spin,
	Table,
	Tag,
	Typography,
	message as antMessage,
} from "antd";
import { statusColor } from "./utils";

const { Text } = Typography;

function locationLabel(platform) {
	if (platform.spaceLocation) {
		return platform.spaceLocation;
	}
	if (platform.currentTarget) {
		return `→ ${platform.currentTarget}`;
	}
	if (platform.speed && platform.speed > 0) {
		return "in transit";
	}
	return "—";
}

function buildInstanceSections(tree) {
	const sections = [];
	for (const host of tree.hosts || []) {
		const sorted = [...(host.instances || [])].sort((a, b) =>
			a.instanceName.localeCompare(b.instanceName)
		);
		for (const instance of sorted) {
			sections.push({ host, instance });
		}
	}
	for (const instance of tree.unassignedInstances || []) {
		sections.push({ host: null, instance });
	}
	return sections;
}

export default function ManualTransferTab({ plugin, state }) {
	const [selectedPlatformKey, setSelectedPlatformKey] = useState(null);
	const [selectedTargetInstance, setSelectedTargetInstance] = useState(null);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const { tree, loadingTree, treeError } = state;

	const platformLookup = useMemo(() => {
		const lookup = new Map();
		if (!tree) {
			return lookup;
		}
		const addInstance = instance => {
			for (const platform of instance.platforms || []) {
				const key = `platform:${instance.instanceId}:${platform.platformIndex}`;
				lookup.set(key, {
					instanceId: instance.instanceId,
					instanceName: instance.instanceName,
					forceName: platform.forceName || tree.forceName || "player",
					...platform,
				});
			}
		};
		for (const host of tree.hosts || []) {
			for (const instance of host.instances || []) {
				addInstance(instance);
			}
		}
		for (const instance of tree.unassignedInstances || []) {
			addInstance(instance);
		}
		return lookup;
	}, [tree]);

	const instanceSections = useMemo(() => {
		if (!tree) {
			return [];
		}
		return buildInstanceSections(tree);
	}, [tree]);

	const selectedSource = selectedPlatformKey ? platformLookup.get(selectedPlatformKey) : null;

	const destinationOptions = useMemo(() => {
		if (!tree) {
			return [];
		}
		const nodes = [];
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
			if (!response.success) {
				throw new Error(response.error || "Transfer start failed");
			}
			antMessage.success(`Transfer started: ${response.transferId}`, 5);
		} catch (err) {
			antMessage.error(err.message || "Failed to start transfer", 10);
		} finally {
			setIsSubmitting(false);
		}
	}

	const platformColumns = [
		{
			title: "Platform",
			key: "name",
			render: (_, row) => (
				<Space>
					<Text>{row.platform.platformName}</Text>
					{row.platform.isLocked ? <Tag color="orange">locked</Tag> : null}
				</Space>
			),
		},
		{
			title: "Location",
			key: "location",
			width: "30%",
			render: (_, row) => {
				const { spaceLocation, currentTarget, speed } = row.platform;
				const label = locationLabel(row.platform);
				const moving = !spaceLocation && (currentTarget || speed > 0);
				return (
					<Text type={moving ? "secondary" : undefined} italic={moving}>
						{label}
					</Text>
				);
			},
		},
		{
			title: "Status",
			key: "status",
			width: "20%",
			render: (_, row) => (
				<Tag color={statusColor(row.platform.transferStatus)}>
					{row.platform.transferStatus || "idle"}
				</Tag>
			),
		},
	];

	const totalHubPlatforms = useMemo(() => {
		let count = 0;
		for (const section of instanceSections) {
			count += (section.instance.platforms || []).filter(p => p.hasSpaceHub).length;
		}
		return count;
	}, [instanceSections]);

	return (
		<div className="surface-export-tab-body">
			<div className="surface-export-tree-panel">
				{loadingTree ? <Spin style={{ margin: "24px auto", display: "block" }} /> : null}
				{treeError ? <Alert type="error" showIcon message={treeError} style={{ marginBottom: 12 }} /> : null}
				{!loadingTree && totalHubPlatforms === 0 ? (
					<Empty description="No platforms with a space hub found" />
				) : null}

				{instanceSections.map(({ host, instance }) => {
					const hubPlatforms = (instance.platforms || []).filter(p => p.hasSpaceHub);
					if (hubPlatforms.length === 0) {
						return null;
					}

					const rows = hubPlatforms.map(platform => ({
						key: `platform:${instance.instanceId}:${platform.platformIndex}`,
						platform,
					}));

					const hostLabel = host ? host.hostName : "Unassigned";
					const connectedTag = instance.connected
						? <Tag color="green">connected</Tag>
						: <Tag color="default">disconnected</Tag>;
					const hostTag = <Tag color={host?.connected ? "blue" : "default"}>{hostLabel}</Tag>;
					const cardTitle = (
						<Space>
							{hostTag}
							<Text strong>{instance.instanceName}</Text>
							{connectedTag}
							{instance.platformError ? <Tag color="warning">error</Tag> : null}
						</Space>
					);

					return (
						<Card
							key={instance.instanceId}
							title={cardTitle}
							size="small"
							style={{ marginBottom: 12 }}
						>
							<Table
								size="small"
								columns={platformColumns}
								dataSource={rows}
								rowKey={row => row.key}
								pagination={false}
								rowClassName={row =>
									row.key === selectedPlatformKey
										? "surface-export-log-row-selected"
										: "surface-export-log-row"
								}
								onRow={row => ({
									onClick: () => {
										setSelectedPlatformKey(row.key);
										setSelectedTargetInstance(null);
									},
								})}
							/>
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
								description={`${selectedSource.instanceName} — ${locationLabel(selectedSource)}`}
							/>
						) : (
							<Alert type="warning" showIcon message="Select a source platform in the table" />
						)}

						<Select
							placeholder="Select destination instance"
							options={destinationOptions}
							value={selectedTargetInstance}
							onChange={setSelectedTargetInstance}
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
