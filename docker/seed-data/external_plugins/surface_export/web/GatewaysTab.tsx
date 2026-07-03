import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
	Alert,
	Button,
	Card,
	Empty,
	Select,
	Space,
	Spin,
	Tag,
	Typography,
	message as antMessage,
} from "antd";
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";

import { getErrorMessage, getProp } from "./utils";
import type { InstanceNodeModel, JsonObject, SurfaceExportPlugin, SurfaceExportState } from "./view-models";

const { Text } = Typography;

type EditableLink = { targetInstanceId: number | null; targetGateway: string };
type RawLink = { sourceInstanceId: number; gatewayName: string; targets: Array<{ targetInstanceId: number; targetGateway: string }> };

/** Composite key that scopes a gateway config to its SOURCE instance (mirrors the controller's map key). */
function editKey(sourceInstanceId: number, gatewayName: string) {
	return `${sourceInstanceId}:${gatewayName}`;
}

/**
 * Gateways tab (WS2): edit which destination instance(s) each gateway links to, PER SOURCE INSTANCE. The
 * controller is the source of truth (keyed by `${sourceInstanceId}:${gatewayName}`); saving pushes only the
 * edited instance its own config, which the in-game on-arrival chooser (WS3) reads. A gateway with no targets
 * is disabled.
 */
export default function GatewaysTab({ plugin, state }: { plugin: SurfaceExportPlugin; state: SurfaceExportState }) {
	const [loading, setLoading] = useState(true);
	const [savingKey, setSavingKey] = useState<string | null>(null);
	const [gatewayNames, setGatewayNames] = useState<string[]>([]);
	// Edits keyed by `${sourceInstanceId}:${gatewayName}`.
	const [edits, setEdits] = useState<Record<string, EditableLink[]>>({});

	const tree = state?.tree;

	// The source instances to render a config section for (every instance in the tree). The gateway
	// prototypes exist cluster-wide, so any instance can be a source.
	const instances = useMemo(() => {
		const nodes: InstanceNodeModel[] = [];
		for (const host of tree?.hosts || []) {
			for (const instance of host.instances || []) {
				nodes.push(instance);
			}
		}
		for (const instance of tree?.unassignedInstances || []) {
			nodes.push(instance);
		}
		return nodes;
	}, [tree]);

	// Destination dropdown options for a given source instance — EXCLUDES the source itself (an instance
	// can't gateway-transfer a platform to its own instance). "online" MUST match the controller's
	// isInstanceOnline (connected AND running), or the editor disagrees with the config that gets pushed.
	const destOptionsFor = useCallback((sourceInstanceId: number) => {
		return instances
			.filter(inst => inst.instanceId !== sourceInstanceId)
			.map(inst => {
				const online = inst.connected && inst.status === "running";
				return {
					label: `${inst.instanceName || `instance ${inst.instanceId}`}${online ? "" : " (offline)"}`,
					value: inst.instanceId,
				};
			});
	}, [instances]);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const resp = (await plugin.getGateways()) as JsonObject;
			const names = (getProp(resp, "gatewayNames", []) as string[]) || [];
			const links = (getProp(resp, "links", []) as RawLink[]) || [];
			setGatewayNames(names);
			const byKey: Record<string, EditableLink[]> = {};
			for (const link of links) {
				byKey[editKey(link.sourceInstanceId, link.gatewayName)] = (link.targets || []).map(t => ({
					targetInstanceId: t.targetInstanceId,
					targetGateway: t.targetGateway,
				}));
			}
			setEdits(byKey);
		} catch (err: unknown) {
			antMessage.error(getErrorMessage(err, "Failed to load gateways"), 8);
		} finally {
			setLoading(false);
		}
	}, [plugin]);

	useEffect(() => { void load(); }, [load]);

	function setTargets(key: string, targets: EditableLink[]) {
		setEdits(prev => ({ ...prev, [key]: targets }));
	}
	function addTarget(key: string, gatewayName: string) {
		setTargets(key, [...(edits[key] || []), { targetInstanceId: null, targetGateway: gatewayName }]);
	}
	function removeTarget(key: string, idx: number) {
		setTargets(key, (edits[key] || []).filter((_, i) => i !== idx));
	}
	function updateTarget(key: string, idx: number, patch: Partial<EditableLink>) {
		setTargets(key, (edits[key] || []).map((t, i) => (i === idx ? { ...t, ...patch } : t)));
	}

	async function save(sourceInstanceId: number, gatewayName: string) {
		const key = editKey(sourceInstanceId, gatewayName);
		const rows = edits[key] || [];
		// Guard the silent-disable trap: if a row exists with no instance picked, error instead of
		// dropping it (which would save fewer/zero targets and quietly disable the gateway). To
		// intentionally disable a gateway, remove all its rows (an empty list is an explicit clear).
		if (rows.some(t => t.targetInstanceId == null)) {
			antMessage.error("Pick a destination instance for every target row, or remove the empty row.", 6);
			return;
		}
		setSavingKey(key);
		try {
			const resp = (await plugin.setGatewayLink({
				sourceInstanceId,
				gatewayName,
				targets: rows.map(t => ({
					targetInstanceId: Number(t.targetInstanceId),
					targetGateway: t.targetGateway || gatewayName,
				})),
			})) as JsonObject;
			if (!getProp(resp, "success", false)) {
				throw new Error(String(getProp(resp, "error", "Save failed")));
			}
			antMessage.success(`Saved ${gatewayName} (${rows.length} target${rows.length === 1 ? "" : "s"})`, 4);
			await load();
		} catch (err: unknown) {
			antMessage.error(getErrorMessage(err, "Failed to save gateway links"), 8);
		} finally {
			setSavingKey(null);
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
				Link each instance's gateways to one or more destination instances. A platform that parks at a
				gateway on that instance and is gateway-transferred arrives at the chosen instance (parked, paused,
				at the target gateway). Changes apply live — no restart.
			</Text>
			{instances.length === 0 ? (
				<Alert
					type="warning"
					showIcon
					message="No instances available"
					description="The instance list (platform tree) is still loading or unavailable — gateways can't be configured until it loads."
				/>
			) : null}
			{instances.map(inst => {
				const online = inst.connected && inst.status === "running";
				return (
					<Card
						key={inst.instanceId}
						size="small"
						title={
							<Space>
								<Text strong>{inst.instanceName || `instance ${inst.instanceId}`}</Text>
								<Tag color={online ? "blue" : "default"}>{online ? "online" : "offline"}</Tag>
							</Space>
						}
					>
						<Space direction="vertical" style={{ width: "100%" }} size="small">
							{gatewayNames.map(gatewayName => {
								const key = editKey(inst.instanceId, gatewayName);
								const targets = edits[key] || [];
								const destOptions = destOptionsFor(inst.instanceId);
								return (
									<Card key={gatewayName} size="small" type="inner" title={gatewayName}>
										<Space direction="vertical" style={{ width: "100%" }}>
											{targets.length === 0 ? (
												<Text type="secondary">No targets — this gateway is disabled.</Text>
											) : null}
											{targets.map((t, idx) => (
												<Space key={idx} wrap>
													<Select
														style={{ minWidth: 240 }}
														placeholder="Destination instance"
														options={destOptions}
														value={t.targetInstanceId ?? undefined}
														onChange={v => updateTarget(key, idx, { targetInstanceId: Number(v) })}
													/>
													<Text type="secondary">→ gateway</Text>
													<Select
														style={{ minWidth: 180 }}
														options={gatewayOptions}
														value={t.targetGateway || gatewayName}
														onChange={v => updateTarget(key, idx, { targetGateway: String(v) })}
													/>
													<Button danger size="small" icon={<DeleteOutlined />} onClick={() => removeTarget(key, idx)} />
												</Space>
											))}
											<Space>
												<Button size="small" icon={<PlusOutlined />} onClick={() => addTarget(key, gatewayName)}>
													Add target
												</Button>
												<Button
													type="primary"
													size="small"
													loading={savingKey === key}
													onClick={() => void save(inst.instanceId, gatewayName)}
												>
													Save
												</Button>
											</Space>
										</Space>
									</Card>
								);
							})}
						</Space>
					</Card>
				);
			})}
		</Space>
	);
}
