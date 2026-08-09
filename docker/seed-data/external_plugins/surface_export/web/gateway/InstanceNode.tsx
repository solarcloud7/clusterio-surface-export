import React, { useCallback, useEffect, useState } from "react";
import { Handle, Position, useUpdateNodeInternals } from "@xyflow/react";
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

/** How long the platform list stays up after the node is clicked. */
const PLATFORM_LIST_VISIBLE_MS = 3000;

/**
 * Show while `active`, then hide after `delayMs` — unless something says to keep it.
 *
 * Three things this has to survive. The first two were found by driving the real canvas rather than
 * reasoning about it; the third is new, and is what makes auto-hide safe now that the list contains a
 * DRAG handle rather than only buttons.
 *
 * `rearm` — WITHOUT THIS THE FEATURE IS A DEAD END. Selection is the only thing that re-shows the
 * list, so once it expires, clicking the SAME node changes nothing: `active` was already true and
 * stays true, and the platform actions are unreachable until the operator clicks elsewhere and back.
 * Measured on the live canvas: node `selected: true`, list in the DOM `0`, clicking it again did
 * nothing. So any pointer press on the node restarts the clock, whatever the selection does.
 *
 * `hovering` — a list that vanishes out from under a cursor that came to click it is worse than one
 * that never hides. Leaving restarts the clock rather than hiding at once, so a pointer that strays
 * and comes back does not lose it.
 *
 * `pressing` — A DRAG LEAVES THE LIST. Dragging a platform onto another instance's portal takes
 * longer than the timeout and moves the pointer far away, so hover alone would delete the element
 * mid-gesture and cancel the connection. A press therefore freezes the clock until the pointer is
 * released ANYWHERE, which is the only event that reliably ends a drag — `pointerup` on the list
 * itself never arrives when the drop lands on another node.
 *
 * THE TWO HOLDS ARE SEPARATE FLAGS, not one shared boolean, and that is the whole point of this
 * shape. Sharing one meant either source could clear the other's hold: the window `pointerup` at the
 * end of a drag switched off a hover that was still true, so the list vanished under a stationary
 * cursor 3s later; and `mouseleave` during a drag switched off the press-hold that existed precisely
 * to survive leaving. Holding while EITHER is true is the only reading that lets each mean what it
 * says.
 */
function useAutoHide(active: boolean, delayMs: number) {
	const [expired, setExpired] = useState(false);
	const [hovering, setHovering] = useState(false);
	const [pressing, setPressing] = useState(false);
	// Bumped to restart the timer even when nothing else in the dependency list has changed — which is
	// exactly the re-click case.
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
		// `once` so it cleans itself up, and on `window` so a drop outside the document body still ends
		// the hold. Releasing also bumps the rearm count, which restarts the clock from the moment the
		// gesture finished rather than from whenever it began — and clears ONLY the press, leaving a
		// hover that is still genuinely true to keep holding on its own account.
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

/**
 * Draw the things that decide behaviour and are otherwise invisible.
 *
 * Every one of these has hidden a bug that took a DOM probe to find:
 *
 * - the MEASURED BOX is what React Flow observes and what `nodeCircle` halves to place the node's
 *   centre; keeping the platform list out of it is why edges still meet the portal. It is also what
 *   `fitView` frames, which is why the list needed its own padding.
 * - the PORTAL is the connect zone. It is 60% of the node raised 16px, and it is invisible by design
 *   (the glow is the affordance) — so "I cannot start a link here" has no visible explanation until
 *   you draw it.
 * - the ANCHOR is where edges actually attach: the node's centre plus GATE_CENTRE_OFFSET_Y, measured
 *   from the art's luminance-weighted glow centroid rather than from the box.
 *
 * `pointer-events: none` throughout — an overlay that swallowed the pointer would break the very
 * connect zone it is drawn to explain.
 */
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
 * THE PLATFORM LIST OPENS ON CLICK and hides itself again, so a busy canvas is not a wall of lists.
 * It hangs under the gate; the caption sits ABOVE, so the two never compete for the same strip. The
 * auto-hide has to be careful in a way it did not when this was only buttons — see `useAutoHide`,
 * whose third rule exists entirely because a platform drag leaves the list and outlasts the timeout.
 */
export function InstanceNode({ id, data, selected, isConnectable }: NodeProps) {
	const node = data as unknown as InstanceNodeData;
	const { showGeometry } = useGatewayDebug();
	// `Boolean(selected)`, not `selected`: NodeProps types it optional, and undefined would hand React
	// Flow's own default back instead of meaning "not selected".
	const list = useAutoHide(Boolean(selected), PLATFORM_LIST_VISIBLE_MS);

	/**
	 * TELL REACT FLOW THE HANDLE SET CHANGED. Without this the platform rows are decorative: you can
	 * see the drag circle and you cannot drag from it.
	 *
	 * `XYHandle.onPointerDown` resolves the pressed handle through the node's cached `handleBounds`,
	 * and React Flow only rebuilds that cache when it MEASURES the node. The platform list is
	 * absolutely positioned outside the node's box — deliberately, so the node stays a 150px circle and
	 * the edges keep meeting the portal — so mounting it never changes the node's size, never trips the
	 * ResizeObserver, and the `p:` handles never enter the cache. The press then finds no handle and
	 * returns before `isValidConnection` is ever consulted, which is why the rules all looked correct.
	 *
	 * This is the exact case `useUpdateNodeInternals` exists for: handles added after the first render.
	 * It went unnoticed because the list was ALWAYS VISIBLE when the drag was first verified — it was
	 * present at measure time — and making it open-on-click is what moved it out of that window.
	 */
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
			// Any press ANYWHERE on the node restarts the list's clock — including on the portal handle,
			// which is a child and so bubbles. `pointerdown` rather than `click` so it also covers a press
			// that turns into a drag or a link, both of which are still the operator working on this node.
			onPointerDown={list.rearm}
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
