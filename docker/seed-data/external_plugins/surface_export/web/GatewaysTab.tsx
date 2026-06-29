import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
	Alert,
	Button,
	Card,
	Empty,
	Select,
	Space,
	Spin,
	Typography,
	message as antMessage,
} from "antd";
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";

import { getErrorMessage, getProp } from "./utils";
import type { InstanceNodeModel, JsonObject, SurfaceExportPlugin, SurfaceExportState } from "./view-models";

const { Text } = Typography;

type EditableLink = { targetInstanceId: number | null; targetGateway: string };

/**
 * Gateways tab (WS2): edit which destination instance(s) each gateway links to. The controller is the
 * source of truth; saving pushes the resolved config to every connected instance, which the in-game
 * on-arrival chooser (WS3) reads. A gateway with no targets is disabled.
 */
export default function GatewaysTab({ plugin, state }: { plugin: SurfaceExportPlugin; state: SurfaceExportState }) {
	const [loading, setLoading] = useState(true);
	const [savingGateway, setSavingGateway] = useState<string | null>(null);
	const [gatewayNames, setGatewayNames] = useState<string[]>([]);
	const [edits, setEdits] = useState<Record<string, EditableLink[]>>({});

	const tree = state?.tree;

	// Destination instance dropdown options (every instance in the tree; offline ones flagged).
	const instanceOptions = useMemo(() => {
		const nodes: InstanceNodeModel[] = [];
		for (const host of tree?.hosts || []) {
			for (const instance of host.instances || []) {
				nodes.push(instance);
			}
		}
		for (const instance of tree?.unassignedInstances || []) {
			nodes.push(instance);
		}
		return nodes.map(inst => {
			// "online" MUST match the controller's isInstanceOnline (connected AND running), or the editor
			// disagrees with the config that gets pushed to instances.
			const online = inst.connected && inst.status === "running";
			return {
				label: `${inst.instanceName || `instance ${inst.instanceId}`}${online ? "" : " (offline)"}`,
				value: inst.instanceId,
			};
		});
	}, [tree]);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const resp = (await plugin.getGateways()) as JsonObject;
			const names = (getProp(resp, "gatewayNames", []) as string[]) || [];
			const links = (getProp(resp, "links", []) as Array<{ gatewayName: string; targets: Array<{ targetInstanceId: number; targetGateway: string }> }>) || [];
			setGatewayNames(names);
			const byName: Record<string, EditableLink[]> = {};
			for (const name of names) {
				byName[name] = [];
			}
			for (const link of links) {
				byName[link.gatewayName] = (link.targets || []).map(t => ({
					targetInstanceId: t.targetInstanceId,
					targetGateway: t.targetGateway,
				}));
			}
			setEdits(byName);
		} catch (err: unknown) {
			antMessage.error(getErrorMessage(err, "Failed to load gateways"), 8);
		} finally {
			setLoading(false);
		}
	}, [plugin]);

	useEffect(() => { void load(); }, [load]);

	function setTargets(gatewayName: string, targets: EditableLink[]) {
		setEdits(prev => ({ ...prev, [gatewayName]: targets }));
	}
	function addTarget(gatewayName: string) {
		setTargets(gatewayName, [...(edits[gatewayName] || []), { targetInstanceId: null, targetGateway: gatewayName }]);
	}
	function removeTarget(gatewayName: string, idx: number) {
		setTargets(gatewayName, (edits[gatewayName] || []).filter((_, i) => i !== idx));
	}
	function updateTarget(gatewayName: string, idx: number, patch: Partial<EditableLink>) {
		setTargets(gatewayName, (edits[gatewayName] || []).map((t, i) => (i === idx ? { ...t, ...patch } : t)));
	}

	async function save(gatewayName: string) {
		const rows = edits[gatewayName] || [];
		// Guard the silent-disable trap: if a row exists with no instance picked, error instead of
		// dropping it (which would save fewer/zero targets and quietly disable the gateway). To
		// intentionally disable a gateway, remove all its rows (an empty list is an explicit clear).
		if (rows.some(t => t.targetInstanceId == null)) {
			antMessage.error("Pick a destination instance for every target row, or remove the empty row.", 6);
			return;
		}
		const valid = rows;
		setSavingGateway(gatewayName);
		try {
			const resp = (await plugin.setGatewayLink({
				gatewayName,
				targets: valid.map(t => ({
					targetInstanceId: Number(t.targetInstanceId),
					targetGateway: t.targetGateway || gatewayName,
				})),
			})) as JsonObject;
			if (!getProp(resp, "success", false)) {
				throw new Error(String(getProp(resp, "error", "Save failed")));
			}
			antMessage.success(`Saved ${gatewayName} (${valid.length} target${valid.length === 1 ? "" : "s"})`, 4);
			await load();
		} catch (err: unknown) {
			antMessage.error(getErrorMessage(err, "Failed to save gateway links"), 8);
		} finally {
			setSavingGateway(null);
		}
	}

	if (loading) {
		return <Spin />;
	}
	if (gatewayNames.length === 0) {
		return <Empty description="No gateways found (is the surfexp_gateways mod loaded on the cluster?)" />;
	}

	const gatewayOptions = gatewayNames.map(n => ({ label: n, value: n }));

	return (
		<Space direction="vertical" style={{ width: "100%" }} size="middle">
			<Text type="secondary">
				Link each gateway to one or more destination instances. A platform that parks at the gateway and
				is gateway-transferred arrives at the chosen instance (parked, paused, at the target gateway).
			</Text>
			{instanceOptions.length === 0 ? (
				<Alert
					type="warning"
					showIcon
					message="No destination instances available"
					description="The instance list (platform tree) is still loading or unavailable — destinations can't be selected until it loads."
				/>
			) : null}
			{gatewayNames.map(gatewayName => {
				const targets = edits[gatewayName] || [];
				return (
					<Card key={gatewayName} size="small" title={gatewayName}>
						<Space direction="vertical" style={{ width: "100%" }}>
							{targets.length === 0 ? (
								<Text type="secondary">No targets — this gateway is disabled.</Text>
							) : null}
							{targets.map((t, idx) => (
								<Space key={idx} wrap>
									<Select
										style={{ minWidth: 240 }}
										placeholder="Destination instance"
										options={instanceOptions}
										value={t.targetInstanceId ?? undefined}
										onChange={v => updateTarget(gatewayName, idx, { targetInstanceId: Number(v) })}
									/>
									<Text type="secondary">→ gateway</Text>
									<Select
										style={{ minWidth: 180 }}
										options={gatewayOptions}
										value={t.targetGateway || gatewayName}
										onChange={v => updateTarget(gatewayName, idx, { targetGateway: String(v) })}
									/>
									<Button danger size="small" icon={<DeleteOutlined />} onClick={() => removeTarget(gatewayName, idx)} />
								</Space>
							))}
							<Space>
								<Button size="small" icon={<PlusOutlined />} onClick={() => addTarget(gatewayName)}>
									Add target
								</Button>
								<Button
									type="primary"
									size="small"
									loading={savingGateway === gatewayName}
									onClick={() => void save(gatewayName)}
								>
									Save
								</Button>
							</Space>
						</Space>
					</Card>
				);
			})}
		</Space>
	);
}
