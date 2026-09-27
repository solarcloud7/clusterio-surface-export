import { useCallback, useContext, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Handle, Position, useStore, useUpdateNodeInternals } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { Typography } from "antd";

import { ONE_GATE_NAME } from "../../shared/dto";
import type { PortalColour } from "../../shared/portals";
import { activePlanets, facingTurn, instanceNodeId, peerPortalHandleId, portalOrientation, sourceHandleId, spreadTurns, targetHandleId } from "./gateway-graph";
import type { PeerPortal, PlatformLike, Portal } from "./gateway-graph";
import PlatformRows from "./PlatformRows";
import { useGatewayDebug } from "./debug-mode";
import { PlanetIcon, usePlanetNames } from "../icons";
import { PORTAL_LINK_COLOUR, portalColour } from "./gateway-colours";
import gatewayHubArt from "./assets/gateway-hub-128.png";
import gatewayBlueArt from "./assets/gateway-blue-64.png";
import gatewayGreenArt from "./assets/gateway-green-64.png";
import gatewayOrangeArt from "./assets/gateway-orange-64.png";
import gatewayPurpleArt from "./assets/gateway-purple-64.png";
import AutoPauseIcon from "./AutoPauseIcon";
import { ShowPlanetsContext } from "./node-actions";

const { Text } = Typography;

const NODE_FACE_ART: Record<string, string> = {
	surfexp_gateway_hub: gatewayHubArt,
};

const PORTAL_ART: Record<PortalColour, string> = {
	blue: gatewayBlueArt,
	green: gatewayGreenArt,
	orange: gatewayOrangeArt,
	purple: gatewayPurpleArt,
};

const NO_PORTAL_NOTE = "No portal: limit of 4 servers. The four portal colours are taken by other servers, "
	+ "so no schedule can stop at a portal leading here. Drag a platform here or use the Gateway instead.";

function colourName(colour: PortalColour): string {
	return colour.charAt(0).toUpperCase() + colour.slice(1);
}

const NODE_CENTRE = 75;
const PORTAL_RING_RADIUS = 94;

function OutgoingPortals({ selfId, peers }: { selfId: string; peers: PeerPortal[] }) {
	const centres = useStore(state => {
		const lookup = state.nodeLookup;
		const centre = (nodeId: string) => {
			const found = lookup.get(nodeId);
			const at = found?.internals?.positionAbsolute;
			return at ? { x: at.x + (found.measured?.width ?? 150) / 2, y: at.y + (found.measured?.height ?? 150) / 2 } : null;
		};
		return JSON.stringify([centre(selfId), ...peers.map(peer => centre(instanceNodeId(peer.instanceId)))]);
	});
	const updateNodeInternals = useUpdateNodeInternals();
	useEffect(() => {
		updateNodeInternals(selfId);
	}, [selfId, centres, updateNodeInternals]);
	const [self, ...others] = JSON.parse(centres) as Array<{ x: number; y: number } | null>;
	const turns = spreadTurns(peers.map((_peer, index) => {
		const other = others[index];
		return self && other ? facingTurn(self, other) : portalOrientation(index, peers.length);
	}));
	return (
		<>
			{peers.map((peer, index) => {
				const turn = turns[index] * 2 * Math.PI;
				const position = {
					left: NODE_CENTRE + PORTAL_RING_RADIUS * Math.sin(turn),
					top: NODE_CENTRE - PORTAL_RING_RADIUS * Math.cos(turn),
				};
				return (
					<div
						key={peer.instanceId}
						className={`surface-export-instance-portal${peer.portal ? "" : " surface-export-instance-portal-none"}`}
						style={position}
						title={peer.portal
							? `${colourName(peer.portal.colour)} Gateway → ${peer.instanceName}: platforms scheduled to this stop travel there`
							: `${peer.instanceName}: ${NO_PORTAL_NOTE}`}
					>
						{peer.portal
							? <img src={PORTAL_ART[peer.portal.colour]} alt={`${peer.portal.colour} portal to ${peer.instanceName}`} draggable={false} />
							: <span className="surface-export-instance-portal-ring" />}
						<Handle
							type="target"
							position={Position.Top}
							id={peerPortalHandleId(peer.instanceId)}
							isConnectable={false}
							className="surface-export-portal-handle"
						/>
					</div>
				);
			})}
		</>
	);
}

function ServerFooter({ portal, instanceName, defaultPlanet, disabledPlanets }: {
	portal: Portal | null;
	instanceName: string;
	defaultPlanet: string;
	disabledPlanets: string[];
}) {
	const showPlanets = useContext(ShowPlanetsContext);
	const installed = usePlanetNames();
	const planets = showPlanets ? activePlanets(installed, defaultPlanet, disabledPlanets) : [];
	return (
		<div className="surface-export-instance-footer">
			<Text
				className="surface-export-instance-portal-label"
				style={portal ? { color: portalColour(portal.colour) } : undefined}
				type={portal ? undefined : "secondary"}
				title={portal
					? `On every other server, the ${colourName(portal.colour)} Gateway leads to ${instanceName}`
					: NO_PORTAL_NOTE}
			>
				{portal ? `${colourName(portal.colour)} Gateway` : "no portal: limit of 4 servers"}
			</Text>
			{planets.length === 0 ? null : <div className="surface-export-instance-planets">
				{planets.map(name => (
					<span
						key={name}
						className={`surface-export-instance-planet${name === defaultPlanet ? " surface-export-instance-planet-default" : ""}`}
						title={name === defaultPlanet ? `${name} (default planet): arrivals land here` : `${name}: available`}
					>
						<PlanetIcon name={name} size={16} title="" />
					</span>
				))}
			</div>}
		</div>
	);
}


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
	instanceId: number;
	instanceName: string;
	address: string;
	online: boolean;
	autoPause?: boolean;
	hostKey: string;
	hostName: string;
	platforms: PlatformLike[];
	defaultPlanet: string;
	disabledPlanets: string[];
	portal: Portal | null;
	peers?: PeerPortal[];
};

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
	const gateway = ONE_GATE_NAME;

	return (
		<div
			className={
				`surface-export-instance-node${node.online ? " surface-export-instance-node-online" : " surface-export-instance-node-offline"}`
				+ " surface-export-instance-node-shaped"
			}
			style={{ "--surface-export-portal-glow": node.portal ? portalColour(node.portal.colour) : PORTAL_LINK_COLOUR } as CSSProperties}
			onPointerDown={list.rearm}
		>
			<Handle
				type="target"
				position={Position.Left}
				id={targetHandleId(gateway)}
				isConnectable={Boolean(isConnectable)}
				isConnectableStart={false}
				className="surface-export-gw-cover"
				title={`Drop a platform here to transfer it to ${node.instanceName}`}
			/>
			<Handle
				type="source"
				position={Position.Right}
				id={sourceHandleId(gateway)}
				isConnectable={false}
				className="surface-export-gw-cover surface-export-gw-anchor"
			/>
			<div
				className="surface-export-instance-face"
				style={NODE_FACE_ART[gateway] ? { backgroundImage: `url(${NODE_FACE_ART[gateway]})` } : undefined}
			>
				{NODE_FACE_ART[gateway] ? null : <PlanetIcon name={gateway} size={96} title={gateway} />}
			</div>

			<div className="surface-export-instance-node-body surface-export-instance-node-caption">
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

			<OutgoingPortals selfId={id} peers={node.peers || []} />
			<ServerFooter
				portal={node.portal ?? null}
				instanceName={node.instanceName}
				defaultPlanet={node.defaultPlanet || "nauvis"}
				disabledPlanets={node.disabledPlanets || []}
			/>

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

			{node.autoPause ? <span className="surface-export-autopause-badge"><AutoPauseIcon /></span> : null}

			{showGeometry ? <GeometryOverlay /> : null}
		</div>
	);
}
