/**
 * What a node's toolbar can DO, handed down by context rather than through node data.
 *
 * React Flow node data is rebuilt from the platform tree on every status push — roughly once a
 * second on a live cluster. Putting callbacks in there would give every node a new `data` object
 * whenever any of them changed, and would make the graph projection (gateway-graph.ts, deliberately
 * pure) responsible for holding React state it has no business knowing about.
 *
 * A context instead: the canvas owns the handlers and the in-flight export key, the node reads them.
 */

import { createContext, useContext } from "react";

import type { PlatformActionSource } from "../platform-actions";

export type GatewayNodeActions = {
	/** `${instanceId}:${platformIndex}` of the export currently running, or null. Drives one spinner. */
	exportingKey: string | null;
	onExport: (source: PlatformActionSource) => void;
	/**
	 * `presetTargetInstanceId` is the destination the gesture already chose, or null when it did not.
	 *
	 * The button in a row cannot know where the platform should go, so it passes null and the dialog
	 * asks. Dragging the row onto another instance's portal HAS named a destination, and re-asking for
	 * it would throw away the only thing that gesture said.
	 */
	onTransfer: (source: PlatformActionSource, presetTargetInstanceId: number | null) => void;
};

/**
 * Null outside a provider. A node rendered without one draws its toolbar disabled rather than
 * throwing — the actions are an addition to the node, not a precondition for it.
 */
export const NodeActionsContext = createContext<GatewayNodeActions | null>(null);

export function platformActionKey(instanceId: number, platformIndex: number): string {
	return `${instanceId}:${platformIndex}`;
}

export function useNodeActions(): GatewayNodeActions | null {
	return useContext(NodeActionsContext);
}
