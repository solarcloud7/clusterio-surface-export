import { useMemo, useRef, useState } from "react";
import {
	Alert,
	Button,
	Input,
	Modal,
	Select,
	Space,
	Upload,
	message as antMessage,
} from "antd";
import type { UploadChangeParam, UploadFile } from "antd/es/upload/interface";
import type { ImportUploadedExportOptions } from "../messages";
import { UploadOutlined } from "@ant-design/icons";

import { usePlanetOptions } from "./icons";
import { destinationOptions, canSelectDestination } from "../shared/destination-options";
import { importableSnapshot, newRestoreRequestId } from "../shared/snapshot";
import { parseJsonFile, getErrorMessage, getProp } from "./utils";
import type { JsonObject, SurfaceExportPlugin, SurfaceExportState } from "./view-models";

export type RestoreSnapshot = { exportId: string; timestamp: number | null; platformName: string };

type ImportModalProps = {
	open: boolean;
	onClose: () => void;
	plugin: SurfaceExportPlugin;
	state: SurfaceExportState;
	snapshot?: RestoreSnapshot;
};

export default function ImportModal({ open, onClose, plugin, state, snapshot }: ImportModalProps) {
	const submitting = useRef(false);
	const [restoreRequestId] = useState(newRestoreRequestId);
	const [restoreError, setRestoreError] = useState<string | null>(null);
	const [restoreOperationId, setRestoreOperationId] = useState<string | null>(null);
	const [fileList, setFileList] = useState<UploadFile[]>([]);
	const [payload, setPayload] = useState<JsonObject | null>(null);
	const [parseError, setParseError] = useState<string | null>(null);
	const [forceName, setForceName] = useState("player");
	const [platformName, setPlatformName] = useState("");
	const [targetInstanceId, setTargetInstanceId] = useState<number | null>(null);
	const [targetPlanet, setTargetPlanet] = useState<string | null>(null);
	const [importing, setImporting] = useState(false);

	const instanceOptions = useMemo(() => destinationOptions(state.tree), [state.tree]);
	const targetAvailable = canSelectDestination(instanceOptions, targetInstanceId);

	const planetOptions = usePlanetOptions();


	function resetState() {
		setFileList([]);
		setPayload(null);
		setParseError(null);
		setForceName("player");
		setPlatformName("");
		setTargetInstanceId(null);
		setTargetPlanet(null);
	}

	function handleClose() {
		resetState();
		onClose();
	}

	async function handleFileChange({ fileList: next }: UploadChangeParam<UploadFile>) {
		const latest = next.slice(-1);
		setFileList(latest);
		setPayload(null);
		setParseError(null);
		if (!latest.length) return;

		const file = latest[0]?.originFileObj;
		if (!file) {
			setParseError("Unable to access selected file");
			return;
		}
		try {
			const parsed = await parseJsonFile(file);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("JSON root must be an object");
			}
			importableSnapshot(parsed);
			setPayload(parsed);
		} catch (err: unknown) {
			console.error("Failed to parse selected import file", err);
			setParseError(getErrorMessage(err, "Invalid JSON file"));
		}
	}

	async function handleSubmit() {
		if (targetInstanceId === null || !targetAvailable || (!payload && !snapshot) || submitting.current || restoreError) return;
		submitting.current = true;
		setImporting(true);
		try {
			const request: ImportUploadedExportOptions = {
				targetInstanceId,
				exportData: snapshot ? {} : payload!,
				restoreExportId: snapshot?.exportId || null,
				restoreRequestId: snapshot ? restoreRequestId : null,
				forceName: forceName || "player",
				platformName: platformName.trim() || null,
			};
			if (targetPlanet) {
				request.targetPlanet = targetPlanet;
			}
			const response = await plugin.importUploadedExport(request) as JsonObject;
			if (!getProp(response, "success", false)) {
				const error = String(getProp(response, "error", "Import failed"));
				const operationId = getProp(response, "operationId", null);
				if (snapshot && typeof operationId === "string") {
					setRestoreOperationId(operationId);
					setRestoreError(error);
				} else setParseError(error);
				antMessage.error(error, 10);
				return;
			}
			handleClose();
		} catch (err: unknown) {
			const error = getErrorMessage(err, "Failed to import JSON");
			if (snapshot) setRestoreError(error);
			antMessage.error(error, 10);
		} finally {
			submitting.current = false;
			setImporting(false);
		}
	}

	return (
		<Modal
			open={open}
			title={snapshot ? "Restore from snapshot" : "Import JSON"}
			onCancel={handleClose}
			onOk={handleSubmit}
			okText={snapshot ? "Restore platform" : "Import"}
			closable={!importing}
			maskClosable={!importing}
			cancelButtonProps={{ disabled: importing }}
			okButtonProps={{ loading: importing, disabled: importing || !!restoreError || (!payload && !snapshot) || !targetAvailable }}
		>
			<Space direction="vertical" size="middle" style={{ width: "100%" }}>
				{snapshot ? <Alert type="warning" showIcon message={snapshot.platformName}
					description={`${snapshot.timestamp == null ? "Snapshot date unavailable" : `Snapshot saved ${new Date(snapshot.timestamp).toLocaleString()}`}. This creates a new platform on the selected destination. Another copy may already exist, including on offline instances. The original transfer history stays unchanged.`} /> : <Upload
					accept=".json,application/json"
					beforeUpload={() => false}
					fileList={fileList}
					maxCount={1}
					onChange={handleFileChange}
				>
					<Button icon={<UploadOutlined />}>Choose JSON export file</Button>
				</Upload>}

				{parseError ? <Alert type="error" showIcon message={parseError} /> : null}
				{restoreError ? <Alert type="error" showIcon message="Restore was not confirmed"
					description={<>{restoreError}. Check this attempt’s transfer history before starting another restoration. {" "}
						{restoreOperationId && <a href={`/surface-export?tab=logs&transfer=${encodeURIComponent(restoreOperationId)}`}>
							View this restoration attempt
						</a>}</>} /> : null}
				{payload && !snapshot ? (
					<Alert
						type="success"
						showIcon
						message="JSON parsed successfully"
						description={`Platform: ${payload.platform_name || "(not specified in file)"}`}
					/>
				) : null}

				<Select
					aria-label="Destination instance"
					placeholder="Select target instance"
					options={instanceOptions}
					value={targetInstanceId}
					onChange={value => setTargetInstanceId(value)}
					style={{ width: "100%" }}
				/>

				<Select
					aria-label="Destination planet"
					placeholder="Select destination planet (optional)"
					options={planetOptions}
					value={targetPlanet}
					onChange={value => setTargetPlanet(value)}
					allowClear
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
			</Space>
		</Modal>
	);
}
