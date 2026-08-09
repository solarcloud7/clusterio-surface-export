import React from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { Typography } from "antd";

import { DEFAULT_GATEWAY_MODE, gatewayNamesFor } from "../../shared/dto";
import type { GatewayMode } from "../../shared/dto";
import { sourceHandleId, targetHandleId } from "./gateway-graph";
import type { GatewayUsage, PlatformLike } from "./gateway-graph";
import PlatformRows from "./PlatformRows";
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
	/** `publicAddress:gamePort` — what you would actually connect to. "" when not running. */
	address: string;
	online: boolean;
	hostKey: string;
	hostName: string;
	/** Already filtered to hub-bearing platforms by buildGraph — the only ones that can be acted on. */
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
 * ONE-GATE: the gateway art IS the node, and the PORTAL is a connection handle. Drag through the
 * glow to link; drag anywhere else — stone base, rim, caption — to move the node.
 *
 * MULTI: four gateways, one per side, each its own handle — there the side IS the gateway's identity,
 * so a node-wide handle would throw away the only thing distinguishing them.
 *
 * LIT vs FADED tracks ONLINE, not link count. An offline instance may well still hold links, and
 * showing it bright because it is configured would say the wrong thing about the thing an operator
 * actually needs to see.
 *
 * THE PLATFORM LIST IS ALWAYS ON, hanging under the gate. It used to be a NodeToolbar that appeared
 * on selection and hid itself after five seconds; a permanent list is what the database-schema-node
 * pattern it now follows actually is, and it is what makes a platform something you can drag. The
 * caption sits ABOVE the gate, so the two never compete for the same strip.
 */
export function InstanceNode({ data, isConnectable }: NodeProps) {
	const node = data as unknown as InstanceNodeData;
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
		>
			{oneGate ? (
				<>
					{/* The PORTAL is the connection zone — drag through the glowing disc to link, which is
					    what a portal is for. Everything outside it (the stone base, the rim, the caption)
					    moves the node, so no separate drag handle is needed. Covering the WHOLE node was
					    the earlier mistake: it left nowhere to grab, and shrinking it to a concentric ring
					    only moved the problem, since a ring centred on the box is thin over the portal and
					    thick over the pedestal. The target sits under the source; connectionMode="loose"
					    means it does not matter which of the two the pointer is over. */}
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
				    The full name stays available on hover — and the HOST rides along there rather than
				    taking a third line, now that the host box is gone: the toolbar's host filter is the
				    affordance for "which host is this", not the caption. */}
				<Text
					strong
					className="surface-export-instance-node-name"
					title={node.hostName ? `${node.instanceName} — on ${node.hostName}` : node.instanceName}
				>
					{node.instanceName}
				</Text>
				<div className="surface-export-instance-node-meta">
					{/* ADDRESS AND PORT AS ONE STRING, because that is how they are used — it is what you
					    paste into a client, not two facts to reassemble. Empty until the instance has
					    started, which is when a port is assigned.

					    NO online/offline tag: the gate art already carries it — lit with a glow when
					    online, greyed and faded when not (see the two -online/-offline face rules in
					    web/style.css). The tag was the same fact a second time, in the row that has the
					    least space for it. */}
					{node.address
						? <Text type="secondary" className="surface-export-instance-node-port">{node.address}</Text>
						: <Text type="secondary" className="surface-export-instance-node-port">no port assigned</Text>}
				</div>
			</div>

			{/* `isConnectable` gates the row handles for the same reason it gates the gateway ones: a
			    read-only account must not be offered a drag that would be refused server-side. */}
			<PlatformRows
				platforms={node.platforms}
				instanceId={node.instanceId}
				instanceName={node.instanceName}
				canEdit={Boolean(isConnectable)}
			/>
		</div>
	);
}
