import React from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { Tag, Typography } from "antd";

import { GATEWAY_NAMES } from "../shared/dto";
import { sourceHandleId, targetHandleId } from "../shared/gateway-graph";
import type { GatewayUsage } from "../shared/gateway-graph";
import { PlanetIcon } from "./icons";

const { Text } = Typography;

/**
 * The four gateways land on the four sides, in prototype order.
 *
 * This is not an arbitrary arrangement: `surfexp_gateways` defines exactly four gateways and React
 * Flow offers exactly four handle positions, so each gateway gets its own side of the circle with no
 * trigonometry and no overlap. The colours are the mod's, and the mapping is POSITIONAL
 * (mods-src/surfexp_gateways/data.lua: GATEWAY_COLOURS = blue, green, orange, purple) — reordering
 * this list silently relabels every handle, so it is derived from GATEWAY_NAMES rather than retyped.
 */
const HANDLE_POSITIONS = [Position.Top, Position.Right, Position.Bottom, Position.Left];

export type InstanceNodeData = {
	instanceId: number;
	instanceName: string;
	gamePort: number | null;
	online: boolean;
	gateways: Record<string, GatewayUsage>;
};

function GatewayHandle({ gatewayName, position, usage, connectable }: {
	gatewayName: string;
	position: Position;
	usage: GatewayUsage;
	connectable: boolean;
}) {
	// Zero outgoing links means a platform parked here cannot leave — the gateway is disabled. The
	// form UI said that in words; on a canvas it has to be visible, or "I drew nothing here" and "this
	// is switched off" look identical. Incoming-only is called out separately because such a gateway
	// is a valid arrival point, just not a departure one.
	const state = usage.outgoing > 0 ? "active" : usage.incoming > 0 ? "arrival-only" : "idle";
	const title = usage.outgoing || usage.incoming
		? `${gatewayName} — ${usage.outgoing} out, ${usage.incoming} in`
		: `${gatewayName} — no targets, this gateway is disabled`;

	// Deliberately NOT wrapped in a positioning div: React Flow's handles are absolutely positioned
	// and resolve against the nearest POSITIONED ancestor, which is meant to be the node itself. A
	// wrapper with any `position` other than static silently collapses all four handles onto one
	// point. The two handles are therefore siblings, placed by React Flow.
	return (
		<>
			{/* Two handles share the spot because a gateway is both an origin and a destination. React
			    Flow only starts a drag from a source and only completes on a target, so the pair is
			    never ambiguous; the target sits underneath and the source carries the art. */}
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
				{/* pointer-events are disabled on the icon in CSS: it is decoration sitting on the
				    handle's hit area, and letting it swallow the pointer would make the handle
				    undraggable exactly where it looks most clickable. */}
				<PlanetIcon name={gatewayName} size={26} title={gatewayName} />
			</Handle>
		</>
	);
}

/** One instance: a circle with a gateway on each side. */
export function InstanceNode({ data, isConnectable }: NodeProps) {
	const node = data as unknown as InstanceNodeData;
	return (
		<div className={`surface-export-instance-node${node.online ? "" : " surface-export-instance-node-offline"}`}>
			{GATEWAY_NAMES.map((gatewayName, index) => (
				<GatewayHandle
					key={gatewayName}
					gatewayName={gatewayName}
					position={HANDLE_POSITIONS[index]}
					usage={node.gateways?.[gatewayName] || { outgoing: 0, incoming: 0 }}
					connectable={Boolean(isConnectable)}
				/>
			))}
			<div className="surface-export-instance-node-body">
				<Text strong className="surface-export-instance-node-name">{node.instanceName}</Text>
				{/* The port disambiguates instances whose names differ only by a digit. Absent until the
				    instance has started, which is when a port is assigned. */}
				{node.gamePort ? <Text type="secondary" className="surface-export-instance-node-port">:{node.gamePort}</Text> : null}
				<Tag color={node.online ? "blue" : "default"}>{node.online ? "online" : "offline"}</Tag>
			</div>
		</div>
	);
}

export type HostGroupNodeData = { hostName: string; connected: boolean };

/**
 * A host, drawn as the box its instances live in.
 *
 * Overrides React Flow's built-in `group` type (registering the name replaces it) purely to carry a
 * label — the built-in is an unlabelled rectangle, which on a two-host cluster would leave the
 * operator guessing which box is which.
 */
export function HostGroupNode({ data }: NodeProps) {
	const node = data as unknown as HostGroupNodeData;
	return (
		<div className="surface-export-host-group">
			<div className="surface-export-host-group-label">
				<Tag color={node.connected ? "blue" : "default"}>{node.hostName}</Tag>
			</div>
		</div>
	);
}

export const CANVAS_NODE_TYPES = {
	instance: InstanceNode,
	group: HostGroupNode,
};
