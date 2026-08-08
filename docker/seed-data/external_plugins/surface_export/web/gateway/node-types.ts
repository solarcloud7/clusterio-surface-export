/**
 * The node and edge type registries React Flow resolves `type` against.
 *
 * Declared OUTSIDE the component that renders the canvas, and never inline in JSX: React Flow
 * compares these objects by identity, so a fresh object literal on every render remounts every node
 * and edge — which shows up as handles that lose their drag mid-gesture rather than as an error.
 *
 * `group` deliberately shadows React Flow's built-in group type; registering the name replaces it,
 * which is how the host box gets a label.
 */
import { HostGroupNode } from "./HostGroupNode";
import { InstanceNode } from "./InstanceNode";
import FloatingEdge from "./FloatingEdge";

export const CANVAS_NODE_TYPES = {
	instance: InstanceNode,
	group: HostGroupNode,
};

export const CANVAS_EDGE_TYPES = {
	floating: FloatingEdge,
};

/** Every gateway edge is floating; the type name is referenced when building edges. */
export const GATEWAY_EDGE_TYPE = "floating";
