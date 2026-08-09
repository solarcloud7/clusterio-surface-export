/**
 * The platforms an instance is carrying, listed under its gate.
 *
 * Modelled on React Flow's database-schema node: a titled panel of fixed-height rows, each row an
 * addressable thing with its own connection handle. Here a row is a PLATFORM and its handle starts a
 * transfer — drag it onto another instance's portal and the Transfer dialog opens with that instance
 * already chosen.
 *
 * OPENS ON CLICK and hides itself again — see `useAutoHide` in InstanceNode.tsx, which owns the
 * timing and the three rules it has to survive.
 *
 * ABSOLUTELY POSITIONED, and that is load-bearing rather than cosmetic. React Flow measures the node
 * element and `nodeCircle` (gateway/edge-geometry.ts) puts the node's centre at
 * `position + measured.height / 2`. A list that grew the node's border box would drag that centre
 * down and every edge would detach from the portal glow and re-attach somewhere near the pedestal.
 * Hanging outside the box — the same trick the caption already uses at `bottom: 100%` — keeps the
 * measured node a 150px circle. Nothing in the LAYOUT reserves room for it: like the toolbar it
 * replaced, it is a transient overlay, and it may briefly cover the node below.
 *
 * A MOCK INSTANCE'S ROWS ARE INERT. They are drawn, because drawing them is the entire point of mock
 * instances — the list's height, the six-row cap, the "+k more" line and the column pitch are what
 * they exist to exercise — but every control on them is disabled. Export and Transfer both go
 * STRAIGHT TO THE CONTROLLER with whatever instance id they are handed, and a mock id is negative:
 * Export would send `exportPlatformForDownload({ sourceInstanceId: -1 })`, and the play button would
 * open the Transfer dialog offering REAL destinations for a platform that does not exist. Neither of
 * debug mode's two structural invariants covers this path — both are about staged gateway edits — so
 * the refusal has to be here, at the controls themselves.
 */
import React from "react";
import { Handle, Position } from "@xyflow/react";
import { Button, Tag, Tooltip, Typography } from "antd";
import { CaretRightOutlined, DownloadOutlined } from "@ant-design/icons";

import { PLATFORM_LIST_MAX_ROWS, platformHandleId } from "./gateway-graph";
import type { PlatformLike } from "./gateway-graph";
import { isMockInstanceId } from "./debug-mode";
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
	// A mock platform has no counterpart on any instance, and both controls below talk STRAIGHT to
	// the controller with whatever id they are given. See the file header.
	const isMock = isMockInstanceId(instanceId);
	const inert = isMock || !actions;
	const mockNote = "This is a mock platform — it does not exist on any instance, so it cannot be exported or transferred.";
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
			<Tooltip title={isMock ? mockNote : "Export JSON"}>
				<Button
					icon={<DownloadOutlined />}
					size="small"
					disabled={inert}
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
			<Tooltip title={isMock
				? mockNote
				: `Drag onto another instance's portal to transfer ${platform.platformName} there — or click to choose a destination`}>
				<Handle
					type="source"
					position={Position.Right}
					id={platformHandleId(platform.platformIndex)}
					// Both halves are refused for a mock: `isConnectable` stops the DRAG, and the click
					// handler is simply not attached. Disabling only one would leave the other reaching the
					// controller by the route nobody was looking at.
					isConnectable={canEdit && !isMock}
					className={`surface-export-platform-handle${canEdit && !isMock ? "" : " surface-export-platform-handle-readonly"}`}
					onClick={inert ? undefined : () => actions?.onTransfer(source, null)}
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

export default function PlatformRows({ platforms, instanceId, instanceName, canEdit, onHold, onRelease, onPressed }: {
	/** Already filtered to hub-bearing platforms by buildGraph — the only ones that can be acted on. */
	platforms: PlatformLike[];
	instanceId: number;
	instanceName: string;
	canEdit: boolean;
	/** Pointer is over the list: freeze the auto-hide clock. */
	onHold: () => void;
	onRelease: () => void;
	/**
	 * Pointer went DOWN on the list: freeze until it comes back up, wherever that happens.
	 *
	 * Separate from `onHold` because a drag leaves: dragging a platform onto another instance's portal
	 * moves the pointer off this element entirely, which fires `onRelease` and lets the list delete
	 * itself mid-gesture — cancelling the very connection it was being dragged to make.
	 */
	onPressed: () => void;
}) {
	// `onMouseLeave` rather than `onPointerLeave` on purpose: a pointer capture during a connection
	// drag suppresses pointerleave, so the two would disagree about whether the cursor had gone.
	const holdProps = {
		onMouseEnter: onHold,
		onMouseLeave: onRelease,
		onPointerDown: onPressed,
	};

	if (!platforms.length) {
		return (
			<div className="surface-export-platform-list surface-export-platform-list-empty nodrag nopan" {...holdProps}>
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
		<div className="surface-export-platform-list nodrag nopan" {...holdProps}>
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
