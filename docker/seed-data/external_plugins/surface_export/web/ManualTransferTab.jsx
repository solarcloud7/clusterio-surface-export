import React, { useContext, useEffect, useMemo, useState } from "react";
import { ControlContext } from "@clusterio/web_ui";
import { planetIconUrl, factorioAssetUrl } from "./utils.js";
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

// Bundled planet icons — webpack picks up whatever PNGs exist in the assets/planets/ folder.
// Add nauvis.png, vulcanus.png, gleba.png, fulgora.png, aquilo.png to that folder to enable them.
const DEFAULT_PLANET_ICON = new URL("./assets/planets/default-planet.svg", import.meta.url).href;

// Build a lookup of bundled planet PNGs from the assets/planets/ directory.
// require.context is a webpack-only API that scans the folder at build time.
const _planetCtx = require.context("./assets/planets", false, /\.png$/);
const BUNDLED_PLANET_ICONS = Object.fromEntries(
	_planetCtx.keys().map(k => [k.replace(/^\.\//, "").replace(/\.png$/, ""), _planetCtx(k)])
);

/**
 * Display a planet icon by name.
 * Priority: bundled PNG (vanilla) → HTTP endpoint (modded) → default SVG.
 * @param {{ planetName: string, token: string, size?: number }} props
 */
function PlanetIcon({ planetName, token, size = 24 }) {
	const bundled = BUNDLED_PLANET_ICONS[planetName];
	const src = bundled ?? planetIconUrl(planetName, token);
	return (
		<img
			src={src}
			alt={planetName}
			title={planetName}
			style={{ width: size, height: size, objectFit: "contain", verticalAlign: "middle" }}
			loading="lazy"
			onError={(e) => { e.target.onerror = null; e.target.src = DEFAULT_PLANET_ICON; }}
		/>
	);
}

/**
 * Display any Factorio asset by its "__mod__/path/to/file.png" reference.
 * Falls back to a generic planet SVG on error.
 * @param {{ assetPath: string, label: string, token: string, size?: number }} props
 */
function FactorioIcon({ assetPath, label, token, size = 24 }) {
	if (!assetPath) return <Tag>{label}</Tag>;
	return (
		<img
			src={factorioAssetUrl(assetPath, token)}
			alt={label}
			title={label}
			style={{ width: size, height: size, objectFit: "contain", verticalAlign: "middle" }}
			loading="lazy"
			onError={(e) => { e.target.onerror = null; e.target.src = DEFAULT_PLANET_ICON; }}
		/>
	);
}

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

function buildHostSections(tree) {
	const sections = [];
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
		String(a.instanceName || "").localeCompare(String(b.instanceName || ""))
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
	const control = useContext(ControlContext);
	const token = control.connector?.token ?? "";
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

	const hostSections = useMemo(() => buildHostSections(tree), [tree]);
	const platformLookup = useMemo(() => {
		const lookup = new Map();
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
			if (!response.success) {
				throw new Error(response.error || "Export failed");
			}
			const filename = `${response.platformName || source.platformName || "platform"}_${sanitizeTimestamp(response.timestamp)}.json`;
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
					<Text>{row.platformName}</Text>
					{row.platform?.isLocked ? <Tag color="orange">locked</Tag> : null}
				</Space>
			),
		},
		{
			title: "Location",
			key: "location",
			width: "35%",
			render: (_, row) => {
				const moving = !row.platform?.spaceLocation && (row.platform?.currentTarget || row.platform?.speed > 0);
				const locationName = row.platform?.spaceLocation || row.platform?.currentTarget;
				return (
					<Space size={6}>
						{locationName ? <PlanetIcon planetName={locationName} token={token} /> : null}
						<Text type={moving ? "secondary" : undefined} italic={moving}>
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
					{!loadingTree && hostSections.length === 0 ? (
						<Empty description="No instances available" />
					) : null}
					{hostSections.map(section => (
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
							{section.instances.map(instance => {
								const rows = (instance.platforms || [])
									.filter(platform => platform.hasSpaceHub)
									.map(platform => platformLookup.get(`platform:${instance.instanceId}:${platform.platformIndex}`))
									.filter(Boolean);
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
												rowKey={row => row.key}
												pagination={false}
												rowClassName={row => (
													row.key === selectedPlatformKey
														? "surface-export-log-row-selected"
														: "surface-export-log-row"
												)}
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
