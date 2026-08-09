/**
 * The platforms an instance is carrying, listed under its gate.
 *
 * Modelled on React Flow's database-schema node: a titled panel of fixed-height rows, each row an
 * addressable thing with its own connection handle. Here a row is a PLATFORM and its handle starts a
 * transfer — drag it onto another instance's portal and the Transfer dialog opens with that instance
 * already chosen.
 *
 * ALWAYS VISIBLE. This replaces the auto-hiding NodeToolbar that used to carry the same two buttons:
 * a permanent list is what the reference component is, and "a list that disappears after five
 * seconds" was a contradiction that needed a re-arm hack to stay usable at all (clicking the same
 * node again did nothing once its toolbar had expired, because selection had not changed).
 *
 * ABSOLUTELY POSITIONED, and that is load-bearing rather than cosmetic. React Flow measures the node
 * element and `nodeCircle` (gateway/edge-geometry.ts) puts the node's centre at
 * `position + measured.height / 2`. A list that grew the node's border box would drag that centre
 * down and every edge would detach from the portal glow and re-attach somewhere near the pedestal.
 * Hanging outside the box — the same trick the caption already uses at `bottom: 100%` — keeps the
 * measured node a 150px circle. The layout reserves the room instead (`platformListHeight`).
 */
import React from "react";
import { Handle, Position } from "@xyflow/react";
import { Button, Tag, Tooltip, Typography } from "antd";
import { CaretRightOutlined, DownloadOutlined } from "@ant-design/icons";

import { PLATFORM_LIST_MAX_ROWS, platformHandleId } from "./gateway-graph";
import type { PlatformLike } from "./gateway-graph";
import { platformActionKey, useNodeActions } from "./node-actions";
import { platformStatus } from "../platform-actions";
import { PlanetIcon } from "../icons";

const { Text } = Typography;

/**
 * One platform.
 *
 * THE LOCATION ICON IS THE POINT of the leading column, and it is why a gateway is drawn as a place
 * rather than as plumbing: `spaceLocation` is where the platform is PARKED, and a gateway is a real
 * `space-location` prototype with its own starmap icon, so a platform waiting at the gate shows the
 * gate's icon here exactly as one at Nauvis shows Nauvis. Falling back to `currentTarget` covers the
 * in-flight case, where "where it is going" is the only location there is.
 *
 * NO ETA in the status (`platformStatus(…, null)`). The countdown needs a per-second timer, and the
 * canvas renders one of these rows for every platform on every instance — a timer here would
 * re-render the whole graph once a second for a suffix on a tag.
 */
function PlatformRow({ platform, instanceId, instanceName, canEdit }: {
	platform: PlatformLike;
	instanceId: number;
	instanceName: string;
	canEdit: boolean;
}) {
	const actions = useNodeActions();
	const status = platformStatus(platform, null);
	const key = platformActionKey(instanceId, platform.platformIndex);
	const locationName = platform.spaceLocation || platform.currentTarget;
	const source = {
		instanceId,
		instanceName,
		platformIndex: platform.platformIndex,
		platformName: platform.platformName,
		forceName: platform.forceName || "player",
	};

	return (
		<div className="surface-export-platform-node-row">
			{locationName
				? <PlanetIcon name={locationName} size={18} title={`at ${locationName}`} />
				: <span className="surface-export-icon-placeholder" />}
			<Text className="surface-export-platform-node-name" title={`${platform.platformName} #${platform.platformIndex}`}>
				{platform.platformName}
			</Text>
			{status.tag
				? <Tag color={status.tag} className="surface-export-platform-node-tag">{status.text}</Tag>
				: <Text type="secondary" className="surface-export-platform-node-tag">{status.text}</Text>}
			<Tooltip title="Export JSON">
				<Button
					icon={<DownloadOutlined />}
					size="small"
					disabled={!actions}
					loading={actions?.exportingKey === key}
					onClick={() => actions?.onExport(source)}
				/>
			</Tooltip>
			{/* THE HANDLE IS THE PLAY BUTTON. There used to be both — an antd primary button that opened
			    the Transfer dialog, and a small dot beside it to drag from — which is two controls for
			    one action, and the dot was too small to read as an affordance at all. Now the circle
			    does both: DRAG it onto another instance's portal to transfer there, or CLICK it to open
			    the dialog and pick a destination (the only route when the destination is off-screen, or
			    when there is nowhere to drop yet).

			    SOURCE ONLY, and never a target: a platform is a thing you send, not a place you send
			    something to. Its own `p:` id namespace is what keeps a drag that ends here from being
			    read as a gateway endpoint — see platformHandleId in gateway-graph.ts, and
			    isValidConnection on the canvas, which refuses the combination outright. */}
			<Tooltip title={`Drag onto another instance's portal to transfer ${platform.platformName} there — or click to choose a destination`}>
				<Handle
					type="source"
					position={Position.Right}
					id={platformHandleId(platform.platformIndex)}
					isConnectable={canEdit}
					className={`surface-export-platform-handle${canEdit ? "" : " surface-export-platform-handle-readonly"}`}
					onClick={() => actions?.onTransfer(source, null)}
				>
					{/* pointer-events are disabled on the caret in CSS, for the same reason the gateway
					    handles disable them on their icon: it is decoration sitting on the handle's hit
					    area, and letting it swallow the pointer would make the handle undraggable exactly
					    where it looks most clickable. */}
					<CaretRightOutlined />
				</Handle>
			</Tooltip>
		</div>
	);
}

export default function PlatformRows({ platforms, instanceId, instanceName, canEdit }: {
	/** Already filtered to hub-bearing platforms by buildGraph — the only ones that can be acted on. */
	platforms: PlatformLike[];
	instanceId: number;
	instanceName: string;
	canEdit: boolean;
}) {
	if (!platforms.length) {
		return (
			<div className="surface-export-platform-list surface-export-platform-list-empty nodrag nopan">
				<Text type="secondary" style={{ fontSize: 11 }}>No platforms with a space hub</Text>
			</div>
		);
	}

	const shown = platforms.slice(0, PLATFORM_LIST_MAX_ROWS);
	const hidden = platforms.length - shown.length;

	return (
		// `nodrag nopan`: this renders inside React Flow's node wrapper, so without them a press on a
		// button is also a press on the canvas — the click still lands, but the node drags out from
		// under the pointer the moment it moves.
		<div className="surface-export-platform-list nodrag nopan">
			{shown.map(platform => (
				<PlatformRow
					key={platformActionKey(instanceId, platform.platformIndex)}
					platform={platform}
					instanceId={instanceId}
					instanceName={instanceName}
					canEdit={canEdit}
				/>
			))}
			{/* Deliberately NOT a handle and NOT clickable. It stands for several platforms at once, so
			    there is no single thing a drag from it could mean; the Manual Transfer tab is where the
			    full list lives. A cap rather than a scroll container because React Flow measures handle
			    positions once — a row scrolled back into view would drag from a stale origin. */}
			{hidden > 0 ? (
				<div className="surface-export-platform-node-row surface-export-platform-node-more">
					<Text type="secondary" style={{ fontSize: 11 }}>
						+{hidden} more — see Manual Transfer
					</Text>
				</div>
			) : null}
		</div>
	);
}
