const STORAGE_KEY = "surface_export.gateway_layout.v2";

const LEGACY_STORAGE_KEYS = ["surface_export.gateway_layout"];

export type SavedLayout = Record<string, { x: number; y: number }>;

export type LayoutNode = { id: string; position: { x: number; y: number } };

export function loadLayout(): SavedLayout {
	try {
		for (const legacy of LEGACY_STORAGE_KEYS) {
			window.localStorage.removeItem(legacy);
		}
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

export function clearLayout(): void {
	try {
		window.localStorage.removeItem(STORAGE_KEY);
	} catch (err: unknown) {
		console.warn("surface_export: could not clear the saved gateway layout", err);
	}
}

export function applySavedLayout<T extends LayoutNode>(nodes: T[], layout: SavedLayout): T[] {
	if (!Object.keys(layout).length) {
		return nodes;
	}
	return nodes.map(node => {
		const saved = layout[node.id];
		return saved ? { ...node, position: { ...saved } } : node;
	});
}
