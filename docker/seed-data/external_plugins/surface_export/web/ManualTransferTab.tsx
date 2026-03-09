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
import type { ColumnsType } from "antd/es/table";
import type { UploadChangeParam, UploadFile } from "antd/es/upload/interface";
import { DownloadOutlined, UploadOutlined } from "@ant-design/icons";
import { sanitizeTimestamp, parseJsonFile, downloadJsonFile, getErrorMessage, formatBytes, getProp } from "./utils";
import type { HostNode, InstanceNode, JsonObject, PlatformSummary, SurfaceExportPlugin, SurfaceExportState } from "./types";

const { Text } = Typography;

type PlatformRow = {
	key: string;
	host: HostNode | null;
	hostName: string;
	instance: InstanceNode;
	instanceId: number;
	instanceName: string;
	platform: PlatformSummary;
	platformIndex: number;
	platformName: string;
	forceName: string;
	locationText: string;
};

function locationLabel(platform: PlatformSummary, nowMs?: number | null) {
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
	const sections: Array<{ key: string; host: HostNode | null; hostName: string; instances: InstanceNode[] }> = [];
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
	const [importModalOpen, setImportModalOpen] = useState(false);
	const [importTargetInstance, setImportTargetInstance] = useState<{ instanceId: number; instanceName: string } | null>(null);
	const [importFileList, setImportFileList] = useState<UploadFile[]>([]);
	const [importPayload, setImportPayload] = useState<JsonObject | null>(null);
	const [importError, setImportError] = useState<string | null>(null);
	const [importForceName, setImportForceName] = useState("player");
	const [importPlatformName, setImportPlatformName] = useState("");
	const [importing, setImporting] = useState(false);

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
		const nodes: InstanceNode[] = [];
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

	function openImportModal(instance: InstanceNode) {
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

	async function handleImportFileChange({ fileList }: UploadChangeParam<UploadFile>) {
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
		} catch (err: unknown) {
			setImportError(getErrorMessage(err, "Invalid JSON file"));
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
			}) as JsonObject;
			if (!getProp(response, "success", false)) {
				throw new Error(String(getProp(response, "error", "Import failed")));
			}
			antMessage.success(
				`Import started on ${importTargetInstance.instanceName}: ${getProp(response, "platformName", "Unknown")}`,
				8,
			);
			setImportModalOpen(false);
		} catch (err: unknown) {
			antMessage.error(getErrorMessage(err, "Failed to import JSON"), 10);
		} finally {
			setImporting(false);
		}
	}

	const platformColumns: ColumnsType<PlatformRow> = [
		{
			title: "Platform",
			key: "name",
			render: (_: unknown, row: PlatformRow) => (
				<Space>
					<Text>{row.platformName}</Text>
					{row.platform?.isLocked ? <Tag color="orange">locked</Tag> : null}
				</Space>
			),
		},
		{
			title: "Location",
			key: "location",
			width: "35%",
			render: (_: unknown, row: PlatformRow) => {
				const moving = !row.platform?.spaceLocation && (row.platform?.currentTarget || (row.platform?.speed || 0) > 0);
				const locationName = row.platform?.spaceLocation || row.platform?.currentTarget;
				return (
					<Space size={6}>
						{locationName ? <div className={`planet-${CSS.escape(locationName)}`} title={locationName} /> : null}
						<Text type={moving ? "secondary" : undefined} italic={moving ? true : undefined}>
							{row.locationText}
						</Text>
					</Space>
				);
			},
		},
		{
			title: "Actions",
			key: "actions",
			width: "20%",
			render: (_: unknown, row: PlatformRow) => (
				<Button
					icon={<DownloadOutlined />}
					size="small"
					loading={exportingPlatformKey === row.key}
					onClick={(event: React.MouseEvent<HTMLElement>) => {
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
					{!loadingTree && hostSections.length === 0 ? (
						<Empty description="No instances available" />
					) : null}
					{hostSections.map((section) => (
						<Card
							key={section.key}
							title={(
								<Space>
									<Tag color={section.host?.connected ? "blue" : "default"}>{section.hostName}</Tag>
									<Text type="secondary">{section.instances.length} instances</Text>
								</Space>
							)}
							size="small"
							style={{ marginBottom: 12 }}
						>
							{section.instances.map((instance) => {
								const rows = (instance.platforms || [])
									.filter((platform) => platform.hasSpaceHub)
									.map((platform) => platformLookup.get(`platform:${instance.instanceId}:${platform.platformIndex}`))
									.filter(Boolean) as PlatformRow[];
								return (
									<Card
										key={`instance:${instance.instanceId}`}
										title={(
											<Space>
												<Text strong>{instance.instanceName}</Text>
												{instance.platformError ? <Tag color="warning">error</Tag> : null}
											</Space>
										)}
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
												rowKey={(row: PlatformRow) => row.key}
												pagination={false}
												rowClassName={(row: PlatformRow) => (
													row.key === selectedPlatformKey
														? "surface-export-log-row-selected"
														: "surface-export-log-row"
												)}
												onRow={(row: PlatformRow) => ({
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
						</Card>
					))}
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
