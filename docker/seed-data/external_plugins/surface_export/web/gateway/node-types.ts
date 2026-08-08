/**
 * The node and edge type registries React Flow resolves `type` against.
 *
 * Declared OUTSIDE the component that renders the canvas, and never inline in JSX: React Flow
 * compares these objects by identity, so a fresh object literal on every render remounts every node
 * and edge — which shows up as handles that lose their drag mid-gesture rather than as an error.
 *
 * One node type. There used to be a `group` type drawing a box per host, with the instances as its
 * React Flow children; hosts are a filter on the canvas toolbar now, so the box and the
 * drag-containment that came with it are gone.
 */
import { InstanceNode } from "./InstanceNode";
import FloatingEdge from "./FloatingEdge";

export const CANVAS_NODE_TYPES = {
	instance: InstanceNode,
};

export const CANVAS_EDGE_TYPES = {
	floating: FloatingEdge,
};

/** Every gateway edge is floating; the type name is referenced when building edges. */
export const GATEWAY_EDGE_TYPE = "floating";
