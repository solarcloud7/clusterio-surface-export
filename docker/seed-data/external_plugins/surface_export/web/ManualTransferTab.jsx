import React, { useEffect, useMemo, useState } from "react";
import {
	Alert,
	Button,
	Card,
	Empty,
	Input,
	Modal,
	Select,
	Space,
	Spin,
	Table,
	Tag,
	Typography,
	Upload,
	message as antMessage,
} from "antd";
import { DownloadOutlined, UploadOutlined } from "@ant-design/icons";

const { Text } = Typography;

function locationLabel(platform, nowMs) {
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

function sanitizeTimestamp(timestamp) {
	return new Date(timestamp || Date.now()).toISOString().replace(/[:.]/g, "-");
}

function downloadJsonFile(data, filename) {
	const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
	URL.revokeObjectURL(url);
}

function parseJsonFile(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			try {
				resolve(JSON.parse(String(reader.result || "")));
			} catch (err) {
				reject(err);
			}
		};
		reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
		reader.readAsText(file);
	});
}

export default function ManualTransferTab({ plugin, state }) {
	const [selectedPlatformKey, setSelectedPlatformKey] = useState(null);
	const [selectedTargetInstance, setSelectedTargetInstance] = useState(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [nowMs, setNowMs] = useState(Date.now());
	const [exportingPlatformKey, setExportingPlatformKey] = useState(null);
	const [importModalOpen, setImportModalOpen] = useState(false);
	const [importTargetInstance, setImportTargetInstance] = useState(null);
	const [importFileList, setImportFileList] = useState([]);
	const [importPayload, setImportPayload] = useState(null);
	const [importError, setImportError] = useState(null);
	const [importForceName, setImportForceName] = useState("player");
	const [importPlatformName, setImportPlatformName] = useState("");
	const [importing, setImporting] = useState(false);

	useEffect(() => {
		const id = setInterval(() => setNowMs(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);

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

	async function handleExportPlatform(row) {
		setExportingPlatformKey(row.key);
		try {
			const response = await plugin.exportPlatformForDownload({
				sourceInstanceId: row.instanceId,
				sourcePlatformIndex: row.platform.platformIndex,
				forceName: row.platform.forceName || tree?.forceName || "player",
			});
			if (!response.success) {
				throw new Error(response.error || "Export failed");
			}
			const filename = `${response.platformName || row.platform.platformName || "platform"}_${sanitizeTimestamp(response.timestamp)}.json`;
			downloadJsonFile(response.exportData, filename);
			antMessage.success(`Export downloaded: ${response.exportId}`, 6);
		} catch (err) {
			antMessage.error(err.message || "Failed to export platform", 10);
		} finally {
			setExportingPlatformKey(null);
		}
	}

	function openImportModal(instance) {
		setImportTargetInstance({
			instanceId: instance.instanceId,
			instanceName: instance.instanceName,
		});
		setImportFileList([]);
		setImportPayload(null);
		setImportError(null);
		setImportForceName("player");
		setImportPlatformName("");
		setImportModalOpen(true);
	}

	async function handleImportFileChange({ fileList }) {
		const next = fileList.slice(-1);
		setImportFileList(next);
		setImportPayload(null);
		setImportError(null);
		if (!next.length) {
			return;
		}

		const file = next[0]?.originFileObj;
		if (!file) {
			setImportError("Unable to access selected file");
			return;
		}

		try {
			const parsed = await parseJsonFile(file);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("JSON root must be an object");
			}
			setImportPayload(parsed);
			if (!parsed.platform_name) {
				antMessage.warning("JSON file is missing platform_name. Set an override below before import.", 8);
			}
		} catch (err) {
			setImportError(err.message || "Invalid JSON file");
		}
	}

	async function submitImport() {
		if (!importTargetInstance || !importPayload) {
			return;
		}
		setImporting(true);
		try {
			const response = await plugin.importUploadedExport({
				targetInstanceId: importTargetInstance.instanceId,
				exportData: importPayload,
				forceName: importForceName || "player",
				platformName: importPlatformName.trim() || null,
			});
			if (!response.success) {
				throw new Error(response.error || "Import failed");
			}
			antMessage.success(
				`Import started on ${importTargetInstance.instanceName}: ${response.platformName || "Unknown"}`,
				8
			);
			setImportModalOpen(false);
		} catch (err) {
			antMessage.error(err.message || "Failed to import JSON", 10);
		} finally {
			setImporting(false);
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
			width: "35%",
			render: (_, row) => {
				const label = locationLabel(row.platform, nowMs);
				const moving = !row.platform.spaceLocation && (row.platform.currentTarget || row.platform.speed > 0);
				return (
					<Text type={moving ? "secondary" : undefined} italic={moving}>
						{label}
					</Text>
				);
			},
		},
		{
			title: "Actions",
			key: "actions",
			width: "20%",
			render: (_, row) => (
				<Button
					icon={<DownloadOutlined />}
					size="small"
					loading={exportingPlatformKey === row.key}
					onClick={event => {
						event.stopPropagation();
						handleExportPlatform(row);
					}}
				>
					Export JSON
				</Button>
			),
		},
	];


	return (
		<>
			<div className="surface-export-tab-body">
				<div className="surface-export-tree-panel">
					{loadingTree ? <Spin style={{ margin: "24px auto", display: "block" }} /> : null}
					{treeError ? <Alert type="error" showIcon message={treeError} style={{ marginBottom: 12 }} /> : null}
					{!loadingTree && instanceSections.length === 0 ? (
						<Empty description="No instances available" />
					) : null}

					{instanceSections.map(({ host, instance }) => {
						const hubPlatforms = (instance.platforms || []).filter(p => p.hasSpaceHub);

						const rows = hubPlatforms.map(platform => ({
							key: `platform:${instance.instanceId}:${platform.platformIndex}`,
							instanceId: instance.instanceId,
							instanceName: instance.instanceName,
							platform,
						}));

						const hostLabel = host ? host.hostName : "Unassigned";
						const hostTag = <Tag color={host?.connected ? "blue" : "default"}>{hostLabel}</Tag>;
						const cardTitle = (
							<Space>
								{hostTag}
								<Text strong>{instance.instanceName}</Text>
								{instance.platformError ? <Tag color="warning">error</Tag> : null}
							</Space>
						);

						return (
							<Card
								key={instance.instanceId}
								title={cardTitle}
								extra={(
									<Button
										icon={<UploadOutlined />}
										size="small"
										onClick={() => openImportModal(instance)}
									>
										Import JSON
									</Button>
								)}
								size="small"
								style={{ marginBottom: 12 }}
							>
								{rows.length ? (
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
								) : (
									<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No platforms with a space hub" />
								)}
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
									description={`${selectedSource.instanceName} — ${locationLabel(selectedSource, nowMs)}`}
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

			<Modal
				open={importModalOpen}
				title={`Import JSON to ${importTargetInstance?.instanceName || ""}`}
				onCancel={() => setImportModalOpen(false)}
				onOk={submitImport}
				okText="Import"
				okButtonProps={{ loading: importing, disabled: !importPayload }}
			>
				<Space direction="vertical" size="middle" style={{ width: "100%" }}>
					<Upload
						accept=".json,application/json"
						beforeUpload={() => false}
						fileList={importFileList}
						maxCount={1}
						onChange={handleImportFileChange}
					>
						<Button icon={<UploadOutlined />}>Choose JSON export file</Button>
					</Upload>

					{importError ? <Alert type="error" showIcon message={importError} /> : null}
					{importPayload ? (
						<Alert
							type="success"
							showIcon
							message="JSON parsed successfully"
							description={`Platform: ${importPayload.platform_name || "(not specified in file)"}`}
						/>
					) : null}

					<Input
						value={importForceName}
						onChange={event => setImportForceName(event.target.value)}
						placeholder="Force name (default: player)"
					/>

					<Input
						value={importPlatformName}
						onChange={event => setImportPlatformName(event.target.value)}
						placeholder="Optional platform name override"
					/>
				</Space>
			</Modal>
		</>
	);
}
