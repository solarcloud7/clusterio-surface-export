import React, { useMemo, useState } from "react";
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
import { UploadOutlined } from "@ant-design/icons";

import { PlanetIcon } from "./icons";
import { parseJsonFile, getErrorMessage, getProp } from "./utils";
import type { JsonObject, SurfaceExportPlugin, SurfaceExportState } from "./view-models";

type ImportModalProps = {
	open: boolean;
	onClose: () => void;
	plugin: SurfaceExportPlugin;
	state: SurfaceExportState;
};

export default function ImportModal({ open, onClose, plugin, state }: ImportModalProps) {
	const [fileList, setFileList] = useState<UploadFile[]>([]);
	const [payload, setPayload] = useState<JsonObject | null>(null);
	const [parseError, setParseError] = useState<string | null>(null);
	const [forceName, setForceName] = useState("player");
	const [platformName, setPlatformName] = useState("");
	const [targetInstanceId, setTargetInstanceId] = useState<number | null>(null);
	const [targetPlanet, setTargetPlanet] = useState<string | null>(null);
	const [importing, setImporting] = useState(false);

	const instanceOptions = useMemo(() => {
		const tree = state.tree;
		if (!tree) return [];
		const nodes: Array<{ label: string; value: number }> = [];
		for (const host of tree.hosts || []) {
			for (const inst of host.instances || []) {
				nodes.push({ label: inst.instanceName, value: inst.instanceId });
			}
		}
		for (const inst of tree.unassignedInstances || []) {
			nodes.push({ label: inst.instanceName, value: inst.instanceId });
		}
		return nodes.sort((a, b) => a.label.localeCompare(b.label));
	}, [state.tree]);

	const planetOptions = useMemo(() => {
		const validPlanets = ["aquilo", "fulgora", "gleba", "nauvis", "vulcanus"];
		return validPlanets.map(name => ({
			value: name,
			label: (
				<Space size={6} align="center">
					<PlanetIcon name={name} size={20} />
					<span>{name}</span>
				</Space>
			),
		}));
	}, []);


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
			setPayload(parsed);
			if (!parsed.platform_name) {
				antMessage.warning("JSON file is missing platform_name. Set an override below before import.", 8);
			}
		} catch (err: unknown) {
			setParseError(getErrorMessage(err, "Invalid JSON file"));
		}
	}

	async function handleSubmit() {
		if (targetInstanceId === null || !payload) return;
		setImporting(true);
		try {
			const request: JsonObject = {
				targetInstanceId,
				exportData: payload,
				forceName: forceName || "player",
				platformName: platformName.trim() || null,
			};
			if (targetPlanet) {
				request.targetPlanet = targetPlanet;
			}
			const response = await plugin.importUploadedExport(request) as JsonObject;
			if (!getProp(response, "success", false)) {
				throw new Error(String(getProp(response, "error", "Import failed")));
			}
			const selectedInstance = instanceOptions.find(o => o.value === targetInstanceId);
			antMessage.success(
				`Import started on ${selectedInstance?.label || "instance"}: ${getProp(response, "platformName", "Unknown")}`,
				8,
			);
			handleClose();
		} catch (err: unknown) {
			antMessage.error(getErrorMessage(err, "Failed to import JSON"), 10);
		} finally {
			setImporting(false);
		}
	}

	return (
		<Modal
			open={open}
			title="Import JSON"
			onCancel={handleClose}
			onOk={handleSubmit}
			okText="Import"
			okButtonProps={{ loading: importing, disabled: !payload || targetInstanceId === null }}
		>
			<Space direction="vertical" size="middle" style={{ width: "100%" }}>
				<Upload
					accept=".json,application/json"
					beforeUpload={() => false}
					fileList={fileList}
					maxCount={1}
					onChange={handleFileChange}
				>
					<Button icon={<UploadOutlined />}>Choose JSON export file</Button>
				</Upload>

				{parseError ? <Alert type="error" showIcon message={parseError} /> : null}
				{payload ? (
					<Alert
						type="success"
						showIcon
						message="JSON parsed successfully"
						description={`Platform: ${payload.platform_name || "(not specified in file)"}`}
					/>
				) : null}

				<Select
					placeholder="Select target instance"
					options={instanceOptions}
					value={targetInstanceId}
					onChange={value => setTargetInstanceId(value)}
					style={{ width: "100%" }}
				/>

				<Select
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
