import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Alert, Modal, Select, message as antMessage } from "antd";
import { ArrowRightOutlined, LoadingOutlined, SafetyCertificateOutlined } from "@ant-design/icons";

import { usePlanetOptions } from "./icons";
import { getErrorMessage, getProp } from "./utils";
import type { PlatformActionSource } from "./platform-actions";
import type { JsonObject, SurfaceExportPlugin, SurfaceExportState } from "./view-models";
import gatewayArt from "./gateway/assets/gateway-hub-128.png";
import "./transfer-modal.css";

type TransferModalProps = {
	source: PlatformActionSource | null;
	presetTargetInstanceId?: number | null;
	onClose: () => void;
	plugin: SurfaceExportPlugin;
	state: SurfaceExportState;
};

export default function TransferModal({ source, presetTargetInstanceId = null, onClose, plugin, state }: TransferModalProps) {
	const [targetInstanceId, setTargetInstanceId] = useState<number | null>(null);
	const [targetPlanet, setTargetPlanet] = useState<string | null>(null);
	const [pendingSources, setPendingSources] = useState<Set<string>>(new Set());
	const pending = useRef(new Set<string>());
	const sourceKey = source ? `${source.instanceId}:${source.platformIndex}` : "";
	const submitting = pendingSources.has(sourceKey);
	const planetOptions = usePlanetOptions();
	const fieldId = useId();

	useEffect(() => {
		setTargetInstanceId(presetTargetInstanceId);
		setTargetPlanet(null);
	}, [source?.instanceId, source?.platformIndex, presetTargetInstanceId]);

	const instanceOptions = useMemo(() => {
		const tree = state.tree;
		if (!tree || !source) {
			return [];
		}
		const nodes = [
			...(tree.hosts || []).flatMap(host => host.instances || []),
			...(tree.unassignedInstances || []),
		];
		return nodes
			.filter(inst => inst.instanceId !== source.instanceId)
			.map(inst => ({
				value: inst.instanceId,
				label: inst.gamePort ? `${inst.instanceName} :${inst.gamePort}` : inst.instanceName,
			}))
			.sort((a, b) => a.label.localeCompare(b.label));
	}, [state.tree, source]);

	async function handleSubmit() {
		if (!source || targetInstanceId === null || pending.current.has(sourceKey)) {
			return;
		}
		pending.current.add(sourceKey);
		setPendingSources(new Set(pending.current));
		onClose();
		try {
			const response = await plugin.startTransfer({
				platformName: source.platformName,
				sourceInstanceId: source.instanceId,
				sourcePlatformIndex: source.platformIndex,
				targetInstanceId: Number(targetInstanceId),
				forceName: source.forceName || "player",
				targetPlanet,
			}) as JsonObject;
			if (!getProp(response, "success", false)) {
				throw new Error(String(getProp(response, "error", "Transfer start failed")));
			}
		} catch (err: unknown) {
			antMessage.error(`${source.platformName}: ${getErrorMessage(err, "Failed to start transfer")}`, 10);
		} finally {
			pending.current.delete(sourceKey);
			setPendingSources(new Set(pending.current));
		}
	}

	return (
		<Modal
			className="se-transfer-modal"
			width={620}
			centered
			open={Boolean(source)}
			title="Transfer platform"
			onCancel={onClose}
			onOk={handleSubmit}
			okText={submitting ? "Starting transfer…" : "Start Transfer"}
			okButtonProps={{ loading: submitting, disabled: submitting || targetInstanceId === null, icon: submitting ? undefined : <ArrowRightOutlined /> }}
			footer={(_, { OkBtn, CancelBtn }) => <div className="se-transfer-footer">
				<p className="se-transfer-assurance"><SafetyCertificateOutlined aria-hidden="true" />
					<span>Arrival is verified before the source is removed.</span></p>
				<div className="se-transfer-actions"><CancelBtn /><OkBtn /></div>
			</div>}
		>
			<div className="se-transfer-body" aria-busy={submitting}>
				{source && <section className="se-transfer-source" aria-label="Source platform">
					<img className="se-transfer-art" src={gatewayArt} alt="" />
					<div className="se-transfer-identity">
						<h3>{source.platformName}</h3>
						<span className="se-transfer-platform-id">Platform #{source.platformIndex}</span>
						<p><span className="se-transfer-origin-label">From</span> {source.instanceName}</p>
					</div>
				</section>}
				<div className="se-transfer-fields">
					<div className="se-transfer-field">
						<label htmlFor={`${fieldId}-instance`}>Destination instance</label>
						<Select
							id={`${fieldId}-instance`}
							aria-label="Target instance"
							disabled={submitting}
							placeholder="Choose an instance"
							options={instanceOptions}
							value={targetInstanceId}
							onChange={value => setTargetInstanceId(value)}
						/>
					</div>
					<div className="se-transfer-field">
						<label htmlFor={`${fieldId}-planet`}>Arrival location <span>Optional</span></label>
						<Select
							id={`${fieldId}-planet`}
							aria-label="Destination location"
							disabled={submitting}
							placeholder="Use default location"
							options={planetOptions}
							value={targetPlanet}
							onChange={value => setTargetPlanet(value ?? null)}
							allowClear
						/>
					</div>
				</div>
				{submitting && <div className="se-transfer-feedback" role="status" aria-live="polite"><Alert type="info" showIcon
					icon={<LoadingOutlined spin />} message="Starting transfer"
					description="This platform already has a transfer request in progress. You can close this window and follow it on the gateway map." /></div>}
			</div>
		</Modal>
	);
}
