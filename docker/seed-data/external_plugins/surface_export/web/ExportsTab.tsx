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
import type { ColumnsType } from "antd/es/table";
import type { UploadChangeParam, UploadFile } from "antd/es/upload/interface";
import { DownloadOutlined, UploadOutlined, ReloadOutlined } from "@ant-design/icons";
import { formatBytes, sanitizeTimestamp, parseJsonFile, downloadJsonFile, getErrorMessage } from "./utils";
import type { JsonObject, SurfaceExportPlugin, SurfaceExportState, StoredExportSummary } from "./types";

const { Text } = Typography;

function formatTimestamp(timestamp: number | null | undefined) {
	if (!timestamp) {
		return "—";
	}
	try {
		return new Date(timestamp).toLocaleString();
	} catch {
		return "—";
	}
}

function getInstanceOptions(tree: SurfaceExportState["tree"]) {
	if (!tree) {
		return [] as Array<{ label: string; value: number }>;
	}
	const options: Array<{ label: string; value: number }> = [];
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

export default function ExportsTab({ plugin, state }: { plugin: SurfaceExportPlugin; state: SurfaceExportState }) {
	const [downloadingExportId, setDownloadingExportId] = useState<string | null>(null);
	const [uploadFileList, setUploadFileList] = useState<UploadFile[]>([]);
	const [parsedUpload, setParsedUpload] = useState<JsonObject | null>(null);
	const [uploadError, setUploadError] = useState<string | null>(null);
	const [targetInstanceId, setTargetInstanceId] = useState<number | null>(null);
	const [forceName, setForceName] = useState("player");
	const [platformName, setPlatformName] = useState("");
	const [importing, setImporting] = useState(false);

	const exportEntries = state.exports || [];
	const loadingExports = Boolean(state.loadingExports);
	const exportsError = state.exportsError || null;
	const instanceOptions = useMemo(() => getInstanceOptions(state.tree), [state.tree]);

	useEffect(() => {
		plugin.listExports().catch(() => {});
	}, [plugin]);

	async function refreshExports() {
		try {
			await plugin.listExports();
		} catch (err: unknown) {
			antMessage.error(getErrorMessage(err, "Failed to refresh exports"), 6);
		}
	}

	async function handleDownload(row: StoredExportSummary) {
		setDownloadingExportId(row.exportId);
		try {
			const response = await plugin.getStoredExport(row.exportId);
			if (!response.success) {
				throw new Error(response.error || "Download failed");
			}
			downloadJsonFile(response.exportData, `${row.platformName || "platform"}_${sanitizeTimestamp(row.timestamp)}.json`);
			antMessage.success(`Downloaded ${row.exportId}`, 4);
		} catch (err: unknown) {
			antMessage.error(getErrorMessage(err, "Failed to download export"), 8);
		} finally {
			setDownloadingExportId(null);
		}
	}

	async function onUploadChange({ fileList }: UploadChangeParam<UploadFile>) {
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
		} catch (err: unknown) {
			setUploadError(getErrorMessage(err, "Invalid JSON file"));
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
				8,
			);
			setUploadFileList([]);
			setParsedUpload(null);
			setUploadError(null);
			setPlatformName("");
		} catch (err: unknown) {
			antMessage.error(getErrorMessage(err, "Import failed"), 10);
		} finally {
			setImporting(false);
		}
	}

	const columns: ColumnsType<StoredExportSummary> = [
		{
			title: "Platform",
			dataIndex: "platformName",
			key: "platformName",
			render: (value: string) => value || "Unknown",
		},
		{
			title: "Export ID",
			dataIndex: "exportId",
			key: "exportId",
			render: (value: string) => <Text code>{value}</Text>,
		},
		{
			title: "Source Instance",
			dataIndex: "instanceId",
			key: "instanceId",
			render: (value: number) => value ?? "—",
		},
		{
			title: "Timestamp",
			dataIndex: "timestamp",
			key: "timestamp",
			render: (value: number) => formatTimestamp(value),
		},
		{
			title: "Size",
			dataIndex: "size",
			key: "size",
			render: (value: number) => formatBytes(value),
		},
		{
			title: "Actions",
			key: "actions",
			render: (_: unknown, row: StoredExportSummary) => (
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
						onChange={value => setTargetInstanceId(value)}
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
