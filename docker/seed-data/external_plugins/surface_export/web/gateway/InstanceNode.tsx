import React from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { Tag, Typography } from "antd";

import { DEFAULT_GATEWAY_MODE, gatewayNamesFor } from "../../shared/dto";
import type { GatewayMode } from "../../shared/dto";
import { sourceHandleId, targetHandleId } from "../../shared/gateway-graph";
import type { GatewayUsage } from "../../shared/gateway-graph";
import { PlanetIcon } from "../icons";
import gatewayHubArt from "./assets/gateway-hub-128.png";

const { Text } = Typography;

/**
 * High-resolution art for gateways drawn at NODE size, keyed by prototype name.
 *
 * The spritesheet's atlas cell for a space-location is 32x32 (measured), so filling a 150 px node
 * from `FactorioIcon` is a 4.7x upscale and looks like it. These are derived from the mod's own
 * 512 px starmap art — see assets/README.md, and `lint:derived-art` keeps them honest.
 *
 * A name NOT in here falls back to the spritesheet rather than rendering nothing, so adding a gateway
 * without adding art degrades to "soft but correct" instead of "blank node".
 */
const NODE_FACE_ART: Record<string, string> = {
	surfexp_gateway_hub: gatewayHubArt,
};

/** Multi mode only: one gateway per side, in prototype order (1=blue, 2=green, 3=orange, 4=purple). */
const MULTI_HANDLE_POSITIONS = [Position.Top, Position.Right, Position.Bottom, Position.Left];

export type InstanceNodeData = {
	mode?: GatewayMode;
	instanceId: number;
	instanceName: string;
	gamePort: number | null;
	online: boolean;
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

	// Deliberately NOT wrapped in a positioning div: React Flow's handles are absolutely positioned
	// and resolve against the nearest POSITIONED ancestor, which is meant to be the node itself. A
	// wrapper with any `position` other than static silently collapses all four onto one point.
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
				{/* pointer-events are disabled on the icon in CSS: it is decoration sitting on the
				    handle's hit area, and letting it swallow the pointer would make the handle
				    undraggable exactly where it looks most clickable. */}
				<PlanetIcon name={gatewayName} size={26} title={gatewayName} />
			</Handle>
		</>
	);
}

/**
 * One instance.
 *
 * ONE-GATE: the gateway art IS the node, and the WHOLE node is a connection handle — "easy connect".
 * Drag from anywhere on the gate to link it; no aiming at a 26px dot. React Flow is explicit about
 * the cost ("you need to define separate drag handles in this case to still be able to drag the
 * node"), so the caption below the node is the grip — see `dragHandle` in shared/gateway-graph.ts.
 *
 * MULTI: four gateways, one per side, each its own handle — there the side IS the gateway's identity,
 * so a node-wide handle would throw away the only thing distinguishing them.
 *
 * LIT vs FADED tracks ONLINE, not link count. An offline instance may well still hold links, and
 * showing it bright because it is configured would say the wrong thing about the thing an operator
 * actually needs to see.
 */
export function InstanceNode({ data, isConnectable }: NodeProps) {
	const node = data as unknown as InstanceNodeData;
	const mode = node.mode || DEFAULT_GATEWAY_MODE;
	const names = gatewayNamesFor(mode);
	const oneGate = mode !== "multi";
	const gateway = names[0];
	const usage = node.gateways?.[gateway] || { outgoing: 0, incoming: 0 };

	return (
		<div className={
			`surface-export-instance-node${node.online ? " surface-export-instance-node-online" : " surface-export-instance-node-offline"}`
			+ (oneGate ? " surface-export-instance-node-shaped" : "")
		}>
			{oneGate ? (
				<>
					{/* Easy connect: both handles cover the entire node, so a drag can start or land
					    anywhere on the gate. The target sits under the source; connectionMode="loose"
					    means it does not matter which of the two the pointer happens to be over. */}
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
						title={`${gateway} — ${usage.outgoing} out, ${usage.incoming} in. Drag anywhere on the gate to link.`}
					/>
					<div
						className="surface-export-instance-face"
						style={NODE_FACE_ART[gateway] ? { backgroundImage: `url(${NODE_FACE_ART[gateway]})` } : undefined}
					>
						{/* Fallback for a gateway with no bundled art: soft, but correct, beats a blank node. */}
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
				{/* One line, truncated. Instance names are long and similar ("clusterio-host-1-instance-1"),
				    so wrapping them to four lines pushed the meaningful part off the shape it labels.
				    The full name stays available on hover. */}
				<Text strong className="surface-export-instance-node-name" title={node.instanceName}>
					{node.instanceName}
				</Text>
				<div className="surface-export-instance-node-meta">
					{/* The port disambiguates instances whose names differ only by a digit. Absent until
					    the instance has started, which is when a port is assigned. */}
					{node.gamePort ? <Text type="secondary" className="surface-export-instance-node-port">:{node.gamePort}</Text> : null}
					<Tag color={node.online ? "blue" : "default"}>{node.online ? "online" : "offline"}</Tag>
				</div>
			</div>
		</div>
	);
}
