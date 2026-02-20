import React, { useEffect, useMemo, useState } from "react";
import {
	Alert,
	Button,
	Card,
	Empty,
	Input,
	Select,
	Space,
	Spin,
	Table,
	Typography,
	Upload,
	message as antMessage,
} from "antd";
import { DownloadOutlined, UploadOutlined, ReloadOutlined } from "@ant-design/icons";

const { Text } = Typography;

function formatTimestamp(timestamp) {
	if (!timestamp) {
		return "—";
	}
	try {
		return new Date(timestamp).toLocaleString();
	} catch {
		return "—";
	}
}

function formatBytes(value) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || numeric < 0) {
		return "—";
	}
	if (numeric < 1024) {
		return `${numeric.toLocaleString()} B`;
	}
	if (numeric < 1024 * 1024) {
		return `${(numeric / 1024).toFixed(1)} KB`;
	}
	return `${(numeric / (1024 * 1024)).toFixed(2)} MB`;
}

function getInstanceOptions(tree) {
	if (!tree) {
		return [];
	}
	const options = [];
	for (const host of tree.hosts || []) {
		for (const instance of host.instances || []) {
			options.push({
				label: instance.instanceName,
				value: instance.instanceId,
			});
		}
	}
	for (const instance of tree.unassignedInstances || []) {
		options.push({
			label: instance.instanceName,
			value: instance.instanceId,
		});
	}
	options.sort((a, b) => String(a.label).localeCompare(String(b.label)));
	return options;
}

function sanitizeFileTimestamp(timestamp) {
	return new Date(timestamp || Date.now()).toISOString().replace(/[:.]/g, "-");
}

function parseJsonFile(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			try {
				const parsed = JSON.parse(String(reader.result || ""));
				resolve(parsed);
			} catch (err) {
				reject(err);
			}
		};
		reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
		reader.readAsText(file);
	});
}

export default function ExportsTab({ plugin, state }) {
	const [downloadingExportId, setDownloadingExportId] = useState(null);
	const [uploadFileList, setUploadFileList] = useState([]);
	const [parsedUpload, setParsedUpload] = useState(null);
	const [uploadError, setUploadError] = useState(null);
	const [targetInstanceId, setTargetInstanceId] = useState(null);
	const [forceName, setForceName] = useState("player");
	const [platformName, setPlatformName] = useState("");
	const [importing, setImporting] = useState(false);

	const exportEntries = state.exports || [];
	const loadingExports = !!state.loadingExports;
	const exportsError = state.exportsError || null;
	const instanceOptions = useMemo(() => getInstanceOptions(state.tree), [state.tree]);

	useEffect(() => {
		plugin.listExports().catch(() => {});
	}, [plugin]);

	async function refreshExports() {
		try {
			await plugin.listExports();
		} catch (err) {
			antMessage.error(err.message || "Failed to refresh exports", 6);
		}
	}

	async function handleDownload(row) {
		setDownloadingExportId(row.exportId);
		try {
			const response = await plugin.getStoredExport(row.exportId);
			if (!response.success) {
				throw new Error(response.error || "Download failed");
			}
			const blob = new Blob([JSON.stringify(response.exportData, null, 2)], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = `${row.platformName || "platform"}_${sanitizeFileTimestamp(row.timestamp)}.json`;
			document.body.appendChild(link);
			link.click();
			document.body.removeChild(link);
			URL.revokeObjectURL(url);
			antMessage.success(`Downloaded ${row.exportId}`, 4);
		} catch (err) {
			antMessage.error(err.message || "Failed to download export", 8);
		} finally {
			setDownloadingExportId(null);
		}
	}

	async function onUploadChange({ fileList }) {
		const next = fileList.slice(-1);
		setUploadFileList(next);
		setParsedUpload(null);
		setUploadError(null);

		if (!next.length) {
			return;
		}

		const file = next[0]?.originFileObj;
		if (!file) {
			setUploadError("Unable to access selected file");
			return;
		}

		try {
			const parsed = await parseJsonFile(file);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("JSON root must be an object");
			}
			setParsedUpload(parsed);
			if (!parsed.platform_name) {
				antMessage.warning("Uploaded JSON is missing platform_name. Enter one manually before import.", 8);
			}
		} catch (err) {
			setUploadError(err.message || "Invalid JSON file");
		}
	}

	async function handleUploadImport() {
		if (!parsedUpload) {
			antMessage.error("Choose a valid JSON export file first", 6);
			return;
		}
		if (targetInstanceId === null) {
			antMessage.error("Select a target instance", 6);
			return;
		}

		setImporting(true);
		try {
			const response = await plugin.importUploadedExport({
				targetInstanceId: Number(targetInstanceId),
				exportData: parsedUpload,
				forceName: forceName || "player",
				platformName: platformName.trim() || null,
			});
			if (!response.success) {
				throw new Error(response.error || "Import failed");
			}
			antMessage.success(
				`Import started: "${response.platformName || "Unknown"}" on instance ${response.targetInstanceId}`,
				8
			);
			setUploadFileList([]);
			setParsedUpload(null);
			setUploadError(null);
			setPlatformName("");
		} catch (err) {
			antMessage.error(err.message || "Import failed", 10);
		} finally {
			setImporting(false);
		}
	}

	const columns = [
		{
			title: "Platform",
			dataIndex: "platformName",
			key: "platformName",
			render: value => value || "Unknown",
		},
		{
			title: "Export ID",
			dataIndex: "exportId",
			key: "exportId",
			render: value => <Text code>{value}</Text>,
		},
		{
			title: "Source Instance",
			dataIndex: "instanceId",
			key: "instanceId",
			render: value => value ?? "—",
		},
		{
			title: "Timestamp",
			dataIndex: "timestamp",
			key: "timestamp",
			render: value => formatTimestamp(value),
		},
		{
			title: "Size",
			dataIndex: "size",
			key: "size",
			render: value => formatBytes(value),
		},
		{
			title: "Actions",
			key: "actions",
			render: (_, row) => (
				<Button
					icon={<DownloadOutlined />}
					size="small"
					onClick={() => handleDownload(row)}
					loading={downloadingExportId === row.exportId}
				>
					Download
				</Button>
			),
		},
	];

	return (
		<div className="surface-export-exports-body">
			<Card
				title="Stored Exports"
				extra={<Button icon={<ReloadOutlined />} onClick={refreshExports}>Refresh</Button>}
			>
				{loadingExports ? <Spin style={{ margin: "24px auto", display: "block" }} /> : null}
				{exportsError ? <Alert type="error" showIcon message={exportsError} style={{ marginBottom: 12 }} /> : null}
				{!loadingExports && exportEntries.length === 0 ? (
					<Empty description="No stored exports available" />
				) : (
					<Table
						size="small"
						columns={columns}
						dataSource={exportEntries}
						rowKey={row => row.exportId}
						pagination={{ pageSize: 10, hideOnSinglePage: true }}
					/>
				)}
			</Card>

			<Card className="surface-export-upload-panel" title="Upload + Import JSON">
				<Space direction="vertical" size="middle" style={{ width: "100%" }}>
					<Upload
						accept=".json,application/json"
						beforeUpload={() => false}
						fileList={uploadFileList}
						maxCount={1}
						onChange={onUploadChange}
					>
						<Button icon={<UploadOutlined />}>Choose JSON export file</Button>
					</Upload>

					{uploadError ? <Alert type="error" showIcon message={uploadError} /> : null}
					{parsedUpload ? (
						<Alert
							type="success"
							showIcon
							message="JSON parsed successfully"
							description={`Platform: ${parsedUpload.platform_name || "(not specified in file)"}`}
						/>
					) : null}

					<Select
						placeholder="Select destination instance"
						options={instanceOptions}
						value={targetInstanceId}
						onChange={setTargetInstanceId}
						style={{ width: "100%" }}
					/>

					<Input
						value={forceName}
						onChange={event => setForceName(event.target.value)}
						placeholder="Force name (default: player)"
					/>

					<Input
						value={platformName}
						onChange={event => setPlatformName(event.target.value)}
						placeholder="Optional platform name override"
					/>

					<Button
						type="primary"
						onClick={handleUploadImport}
						disabled={!parsedUpload || targetInstanceId === null}
						loading={importing}
						block
					>
						Upload + Import
					</Button>
				</Space>
			</Card>
		</div>
	);
}
