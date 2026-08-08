/**
 * Where the operator dragged each node, remembered across reloads.
 *
 * TWO KINDS OF CHANGE, TWO SAVE MODELS, and the split is the point. A gateway link changes what the
 * cluster DOES — a platform can fly somewhere it could not before — so it stages behind an explicit
 * Save with a pending count and a Revert. A node position changes nothing but the picture, so
 * making someone confirm it would be ceremony, and folding it into the same Save button would make
 * "2 unsaved changes" mean two different kinds of thing at once.
 *
 * LOCAL, not controller-side. A layout is one operator's view of the graph, like a window size; it
 * carries no cluster state, needs no permission, and cannot fail a push. The cost is that it does
 * not follow you to another browser — which is the honest trade for not inventing a wire message
 * and a persistence path for something nobody else needs to agree with.
 */

const STORAGE_KEY = "surface_export.gateway_layout";

export type SavedLayout = Record<string, { x: number; y: number }>;

export type LayoutNode = { id: string; position: { x: number; y: number } };

/**
 * Read the saved layout, or an empty one.
 *
 * Every failure here is recoverable by ignoring the stored value — localStorage throws outright in
 * some privacy modes, and the payload is whatever was in the key last, which a different version of
 * this code may have written. But it is NOT swallowed: a layout that silently stops persisting is
 * the kind of thing that gets rediscovered as a bug months later, so the reason is logged.
 */
export function loadLayout(): SavedLayout {
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) {
			return {};
		}
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {};
		}
		const layout: SavedLayout = {};
		for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
			const point = value as { x?: unknown; y?: unknown };
			if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) {
				layout[id] = { x: Number(point.x), y: Number(point.y) };
			}
		}
		return layout;
	} catch (err: unknown) {
		console.warn("surface_export: could not read the saved gateway layout; using the default one", err);
		return {};
	}
}

/**
 * Persist the positions of the nodes CURRENTLY on the canvas.
 *
 * Writing the live set rather than merging into the stored one is what keeps this from growing
 * forever: an instance removed from the cluster drops out of the file the next time anything moves,
 * with no separate reaping pass to forget to write.
 */
export function saveLayout(nodes: readonly LayoutNode[]): void {
	const layout: SavedLayout = {};
	for (const node of nodes) {
		if (node?.id && Number.isFinite(node.position?.x) && Number.isFinite(node.position?.y)) {
			layout[node.id] = { x: node.position.x, y: node.position.y };
		}
	}
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
	} catch (err: unknown) {
		console.warn("surface_export: could not save the gateway layout; it will reset on reload", err);
	}
}

/**
 * Put each node where it was last left, leaving the computed layout for ones never moved.
 *
 * Applied to the freshly BUILT graph, before `preservePositions` — so a node the operator has moved
 * this session keeps its live position, and a node appearing for the first time this session starts
 * from wherever it was left last time.
 */
export function applySavedLayout<T extends LayoutNode>(nodes: T[], layout: SavedLayout): T[] {
	if (!Object.keys(layout).length) {
		return nodes;
	}
	return nodes.map(node => {
		const saved = layout[node.id];
		return saved ? { ...node, position: { ...saved } } : node;
	});
}
