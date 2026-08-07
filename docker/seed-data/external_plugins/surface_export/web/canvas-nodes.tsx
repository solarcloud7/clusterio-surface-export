import React from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { Tag, Typography } from "antd";

import { DEFAULT_GATEWAY_MODE, gatewayNamesFor } from "../shared/dto";
import type { GatewayMode } from "../shared/dto";
import { sourceHandleId, targetHandleId } from "../shared/gateway-graph";
import type { GatewayUsage, HandleSide } from "../shared/gateway-graph";
import { PlanetIcon } from "./icons";

const { Text } = Typography;

/**
 * The four sides of a node, in prototype order.
 *
 * In MULTI mode this is one side per gateway: `surfexp_gateways` defines exactly four and React Flow
 * offers exactly four positions, so each gets its own side with no trigonometry and no overlap. The
 * mapping is POSITIONAL (mods-src/surfexp_gateways/data.lua: GATEWAY_COLOURS = blue, green, orange,
 * purple), so it is derived from the name list rather than retyped.
 *
 * In ONE-GATE mode the same four sides all belong to the single gateway — the icon sits at the
 * centre, because there the gate IS the instance, and the sides exist only so a link can be drawn
 * from whichever direction is convenient.
 */
const HANDLE_SIDES: Array<{ position: Position; side: HandleSide }> = [
	{ position: Position.Top, side: "top" },
	{ position: Position.Right, side: "right" },
	{ position: Position.Bottom, side: "bottom" },
	{ position: Position.Left, side: "left" },
];

export type InstanceNodeData = {
	mode?: GatewayMode;
	instanceId: number;
	instanceName: string;
	gamePort: number | null;
	online: boolean;
	gateways: Record<string, GatewayUsage>;
};

function GatewayHandle({ gatewayName, position, side, usage, connectable, showIcon }: {
	gatewayName: string;
	position: Position;
	/** Omitted in multi mode, where a gateway owns exactly one side and needs no discriminator. */
	side?: HandleSide;
	usage: GatewayUsage;
	connectable: boolean;
	/** False for one-gate mode's side handles: the icon is drawn once, at the node's centre. */
	showIcon: boolean;
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
				id={targetHandleId(gatewayName, side)}
				isConnectable={connectable}
				className="surface-export-gw-handle surface-export-gw-handle-target"
			/>
			<Handle
				type="source"
				position={position}
				id={sourceHandleId(gatewayName, side)}
				isConnectable={connectable}
				title={title}
				className={
					`surface-export-gw-handle surface-export-gw-handle-source surface-export-gw-${state}`
					+ (showIcon ? "" : " surface-export-gw-handle-bare")
				}
			>
				{/* pointer-events are disabled on the icon in CSS: it is decoration sitting on the
				    handle's hit area, and letting it swallow the pointer would make the handle
				    undraggable exactly where it looks most clickable. */}
				{showIcon ? <PlanetIcon name={gatewayName} size={26} title={gatewayName} /> : null}
			</Handle>
		</>
	);
}

/**
 * One instance.
 *
 * MULTI: a circle with a different gateway on each side — four gates, four icons.
 * ONE-GATE: a circle whose single gate is drawn at the CENTRE, with four plain connection points
 * around the rim. Drawing the one gate once, large, says what the mode means: the instance and its
 * gateway are the same thing. Four rim handles rather than one simply spares the operator dragging
 * every link out of the same spot.
 */
export function InstanceNode({ data, isConnectable }: NodeProps) {
	const node = data as unknown as InstanceNodeData;
	const mode = node.mode || DEFAULT_GATEWAY_MODE;
	const names = gatewayNamesFor(mode);
	const oneGate = mode !== "multi";
	const usageFor = (name: string) => node.gateways?.[name] || { outgoing: 0, incoming: 0 };

	return (
		<div className={`surface-export-instance-node${node.online ? "" : " surface-export-instance-node-offline"}`}>
			{oneGate
				? HANDLE_SIDES.map(({ position, side }) => (
					<GatewayHandle
						key={side}
						gatewayName={names[0]}
						position={position}
						side={side}
						usage={usageFor(names[0])}
						connectable={Boolean(isConnectable)}
						showIcon={false}
					/>
				))
				: names.map((gatewayName, index) => (
					<GatewayHandle
						key={gatewayName}
						gatewayName={gatewayName}
						position={HANDLE_SIDES[index].position}
						usage={usageFor(gatewayName)}
						connectable={Boolean(isConnectable)}
						showIcon
					/>
				))}
			<div className="surface-export-instance-node-body">
				{oneGate ? (
					<span
						className={`surface-export-instance-gate surface-export-gw-${usageFor(names[0]).outgoing > 0 ? "active" : "idle"}`}
						title={`${names[0]} — ${usageFor(names[0]).outgoing} out, ${usageFor(names[0]).incoming} in`}
					>
						<PlanetIcon name={names[0]} size={44} title={names[0]} />
					</span>
				) : null}
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
