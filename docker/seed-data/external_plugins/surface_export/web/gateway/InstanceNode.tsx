import React, { useCallback, useEffect, useState } from "react";
import { Handle, Position, useStore, useUpdateNodeInternals } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { Typography } from "antd";

import { DEFAULT_GATEWAY_MODE, gatewayNamesFor } from "../../shared/dto";
import type { GatewayMode } from "../../shared/dto";
import { sourceHandleId, targetHandleId } from "./gateway-graph";
import type { GatewayUsage, PlatformLike } from "./gateway-graph";
import PlatformRows from "./PlatformRows";
import { useGatewayDebug } from "./debug-mode";
import { PlanetIcon } from "../icons";
import gatewayHubArt from "./assets/gateway-hub-128.png";

const { Text } = Typography;

const NODE_FACE_ART: Record<string, string> = {
	surfexp_gateway_hub: gatewayHubArt,
};

const MULTI_HANDLE_POSITIONS = [Position.Top, Position.Right, Position.Bottom, Position.Left];

const PLATFORM_LIST_VISIBLE_MS = 3000;

function useAutoHide(active: boolean, delayMs: number) {
	const [expired, setExpired] = useState(false);
	const [hovering, setHovering] = useState(false);
	const [pressing, setPressing] = useState(false);
	const [rearmCount, setRearmCount] = useState(0);
	const held = hovering || pressing;

	useEffect(() => {
		if (!active) {
			setExpired(false);
			setHovering(false);
			setPressing(false);
			return undefined;
		}
		if (held) {
			return undefined;
		}
		setExpired(false);
		const timer = setTimeout(() => setExpired(true), delayMs);
		return () => clearTimeout(timer);
	}, [active, held, delayMs, rearmCount]);

	const holdUntilPointerUp = useCallback(() => {
		setPressing(true);
		window.addEventListener("pointerup", () => {
			setPressing(false);
			setRearmCount(count => count + 1);
		}, { once: true });
	}, []);

	return {
		visible: active && !expired,
		hold: useCallback(() => setHovering(true), []),
		release: useCallback(() => setHovering(false), []),
		rearm: useCallback(() => setRearmCount(count => count + 1), []),
		holdUntilPointerUp,
	};
}

function GeometryOverlay() {
	return (
		<div className="surface-export-geometry-overlay">
			<div className="surface-export-geometry-box">
				<span className="surface-export-geometry-tag">measured 150×150</span>
			</div>
			<div className="surface-export-geometry-portal">
				<span className="surface-export-geometry-tag surface-export-geometry-tag-portal">portal</span>
			</div>
			<div className="surface-export-geometry-anchor" />
		</div>
	);
}

export type InstanceNodeData = {
	mode?: GatewayMode;
	instanceId: number;
	instanceName: string;
	address: string;
	online: boolean;
	hostKey: string;
	hostName: string;
	platforms: PlatformLike[];
	gateways: Record<string, GatewayUsage>;
};

function MultiGatewayHandle({ gatewayName, position, usage, connectable }: {
	gatewayName: string;
	position: Position;
	usage: GatewayUsage;
	connectable: boolean;
}) {
	const state = usage.outgoing > 0 ? "active" : usage.incoming > 0 ? "arrival-only" : "idle";
	const title = usage.outgoing || usage.incoming
		? `${gatewayName} — ${usage.outgoing} out, ${usage.incoming} in`
		: `${gatewayName} — no targets, this gateway is disabled`;

	return (
		<>
			<Handle
				type="target"
				position={position}
				id={targetHandleId(gatewayName)}
				isConnectable={connectable}
				className="surface-export-gw-handle surface-export-gw-handle-target"
			/>
			<Handle
				type="source"
				position={position}
				id={sourceHandleId(gatewayName)}
				isConnectable={connectable}
				title={title}
				className={`surface-export-gw-handle surface-export-gw-handle-source surface-export-gw-${state}`}
			>
				<PlanetIcon name={gatewayName} size={26} title={gatewayName} />
			</Handle>
		</>
	);
}

export function InstanceNode({ id, data, selected, isConnectable }: NodeProps) {
	const node = data as unknown as InstanceNodeData;
	const { showGeometry } = useGatewayDebug();
	const multiSelected = useStore(store => {
		let seen = 0;
		for (const node of store.nodeLookup.values()) {
			if (node.selected && ++seen > 1) return true;
		}
		return false;
	});
	const list = useAutoHide(Boolean(selected) && !multiSelected, PLATFORM_LIST_VISIBLE_MS);

	const updateNodeInternals = useUpdateNodeInternals();
	useEffect(() => {
		updateNodeInternals(id);
	}, [id, list.visible, node.platforms.length, updateNodeInternals]);
	const mode = node.mode || DEFAULT_GATEWAY_MODE;
	const names = gatewayNamesFor(mode);
	const oneGate = mode !== "multi";
	const gateway = names[0];
	const usage = node.gateways?.[gateway] || { outgoing: 0, incoming: 0 };

	return (
		<div
			className={
				`surface-export-instance-node${node.online ? " surface-export-instance-node-online" : " surface-export-instance-node-offline"}`
				+ (oneGate ? " surface-export-instance-node-shaped" : "")
			}
			onPointerDown={list.rearm}
		>
			{oneGate ? (
				<>
					<Handle
						type="target"
						position={Position.Left}
						id={targetHandleId(gateway)}
						isConnectable={Boolean(isConnectable)}
						className="surface-export-gw-cover"
					/>
					<Handle
						type="source"
						position={Position.Right}
						id={sourceHandleId(gateway)}
						isConnectable={Boolean(isConnectable)}
						className="surface-export-gw-cover"
						title={`${gateway} — ${usage.outgoing} out, ${usage.incoming} in. Drag through the portal to link.`}
					/>
					<div
						className="surface-export-instance-face"
						style={NODE_FACE_ART[gateway] ? { backgroundImage: `url(${NODE_FACE_ART[gateway]})` } : undefined}
					>
						{NODE_FACE_ART[gateway] ? null : <PlanetIcon name={gateway} size={96} title={gateway} />}
					</div>
				</>
			) : names.map((gatewayName, index) => (
				<MultiGatewayHandle
					key={gatewayName}
					gatewayName={gatewayName}
					position={MULTI_HANDLE_POSITIONS[index]}
					usage={node.gateways?.[gatewayName] || { outgoing: 0, incoming: 0 }}
					connectable={Boolean(isConnectable)}
				/>
			))}

			<div className={`surface-export-instance-node-body${oneGate ? " surface-export-instance-node-caption" : ""}`}>
				<Text
					strong
					className="surface-export-instance-node-name"
					title={node.hostName ? `${node.instanceName} — on ${node.hostName}` : node.instanceName}
				>
					{node.instanceName}
				</Text>
				<div className="surface-export-instance-node-meta">
					{node.address
						? <Text type="secondary" className="surface-export-instance-node-port">{node.address}</Text>
						: <Text type="secondary" className="surface-export-instance-node-port">no port assigned</Text>}
				</div>
			</div>

			{list.visible ? (
				<PlatformRows
					platforms={node.platforms}
					instanceId={node.instanceId}
					instanceName={node.instanceName}
					canEdit={Boolean(isConnectable)}
					onHold={list.hold}
					onRelease={list.release}
					onPressed={list.holdUntilPointerUp}
				/>
			) : null}

			{showGeometry ? <GeometryOverlay /> : null}
		</div>
	);
}
