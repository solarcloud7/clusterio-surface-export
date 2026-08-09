import React, { useEffect, useMemo, useState } from "react";
import { Alert, Modal, Select, Space, message as antMessage } from "antd";

import { usePlanetOptions } from "./icons";
import { getErrorMessage, getProp } from "./utils";
import type { PlatformActionSource } from "./platform-actions";
import type { JsonObject, SurfaceExportPlugin, SurfaceExportState } from "./view-models";

/**
 * Start a transfer for ONE already-chosen platform.
 *
 * Deliberately narrower than ImportModal: there is no force field and no platform-name override,
 * because a transfer carries an existing platform's own force and name rather than constructing a
 * new one from an uploaded file. The only two decisions left are where it goes and where it lands.
 *
 * Its input is `PlatformActionSource` — the same shape the export action takes, declared once in
 * platform-actions.ts. This file used to declare its own identical `TransferSource`, which meant two
 * callers (the Manual Transfer table and the canvas toolbar) could satisfy one and not the other.
 */
type TransferModalProps = {
	source: PlatformActionSource | null;
	/**
	 * The destination the OPENING GESTURE already chose, or null when it chose none.
	 *
	 * Set when a platform row was dragged onto another instance's portal on the gateway canvas: that
	 * drag named a destination, and re-asking for it would discard the only thing it said. Null from
	 * every button, which names a platform and nothing else.
	 */
	presetTargetInstanceId?: number | null;
	onClose: () => void;
	plugin: SurfaceExportPlugin;
	state: SurfaceExportState;
};

export default function TransferModal({ source, presetTargetInstanceId = null, onClose, plugin, state }: TransferModalProps) {
	const [targetInstanceId, setTargetInstanceId] = useState<number | null>(null);
	const [targetPlanet, setTargetPlanet] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const planetOptions = usePlanetOptions();

	// Clear the previous platform's choices when the modal is re-opened for a different row —
	// otherwise a destination picked for one platform silently pre-fills for the next. The preset is
	// in the dependency list so that re-opening for the SAME platform with a different destination
	// (drag it one way, then the other) takes the new one rather than keeping the first.
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
			// The source instance is not a legal destination — the controller refuses it with
			// "Source and destination instances must be different", so never offer it.
			.filter(inst => inst.instanceId !== source.instanceId)
			.map(inst => ({
				value: inst.instanceId,
				label: inst.gamePort ? `${inst.instanceName} :${inst.gamePort}` : inst.instanceName,
			}))
			.sort((a, b) => a.label.localeCompare(b.label));
	}, [state.tree, source]);

	async function handleSubmit() {
		if (!source || targetInstanceId === null) {
			return;
		}
		setSubmitting(true);
		try {
			const response = await plugin.startTransfer({
				sourceInstanceId: source.instanceId,
				sourcePlatformIndex: source.platformIndex,
				targetInstanceId: Number(targetInstanceId),
				forceName: source.forceName || "player",
				targetPlanet,
			}) as JsonObject;
			if (!getProp(response, "success", false)) {
				throw new Error(String(getProp(response, "error", "Transfer start failed")));
			}
			antMessage.success(`Transfer started: ${getProp(response, "transferId", "")}`, 5);
			onClose();
		} catch (err: unknown) {
			antMessage.error(getErrorMessage(err, "Failed to start transfer"), 10);
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<Modal
			open={Boolean(source)}
			title={source ? `Transfer ${source.platformName}` : "Transfer"}
			onCancel={onClose}
			onOk={handleSubmit}
			okText="Start Transfer"
			okButtonProps={{ loading: submitting, disabled: targetInstanceId === null }}
		>
			<Space direction="vertical" size="middle" style={{ width: "100%" }}>
				{source ? (
					<Alert
						type="info"
						showIcon
						message={`${source.platformName} #${source.platformIndex}`}
						description={`from ${source.instanceName}`}
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
					placeholder="Select destination location (optional)"
					options={planetOptions}
					value={targetPlanet}
					onChange={value => setTargetPlanet(value ?? null)}
					allowClear
					style={{ width: "100%" }}
				/>
			</Space>
		</Modal>
	);
}
