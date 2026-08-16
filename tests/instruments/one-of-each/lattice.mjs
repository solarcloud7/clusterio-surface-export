// lattice — the one-of-each fixture's cell allocation, in the gallery's cell vocabulary
//
// requires: universe entries carrying a measured footprint (tile_width/tile_height/collision_box),
//           and the reviewed constraints in placement-rules.json
// produces: one cell per entry with an engine-aligned position, the cell class that satisfied the
//           entry's edge constraint, and the arithmetic to check no two footprints overlap
// does not: contact the cluster, create anything, decide whether create_entity will accept a
//           position (only the engine does that), or silently drop an entry it cannot satisfy —
//           an unsatisfiable constraint comes back in `unplaced`

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RULES_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "placement-rules.json");

export const CELL_PITCH = { x: 28, y: 14 };
export const CELL_INNER = { width: 26, height: 12 };
export const CELL_CLASSES = ["edge_south", "edge_outward", "interior"];

let cachedRules = null;

export function loadPlacementRules() {
	if (cachedRules === null) cachedRules = JSON.parse(readFileSync(RULES_PATH, "utf8"));
	return cachedRules;
}

export function ruleFor(rules, type) {
	return (rules.rules || {})[type] || null;
}

export function cellClass(column, row, columns, rows) {
	if (row === rows - 1) return "edge_south";
	if (row === 0 || column === 0 || column === columns - 1) return "edge_outward";
	return "interior";
}

export function cellsFor(columns, rows, origin) {
	const cells = [];
	for (let row = 0; row < rows; row++) {
		for (let column = 0; column < columns; column++) {
			cells.push({
				column, row,
				cellClass: cellClass(column, row, columns, rows),
				left: origin.x + column * CELL_PITCH.x,
				top: origin.y + row * CELL_PITCH.y,
			});
		}
	}
	return cells;
}

export function positionIn(cell, tileWidth, tileHeight) {
	const width = Math.max(tileWidth, 1);
	const height = Math.max(tileHeight, 1);
	const offsetX = Math.floor((CELL_INNER.width - width) / 2);
	const offsetY = Math.floor((CELL_INNER.height - height) / 2);
	return { x: cell.left + offsetX + width / 2, y: cell.top + offsetY + height / 2 };
}

export function collisionFootprint(position, collisionBox) {
	const [left, top, right, bottom] = collisionBox;
	return {
		left: position.x + left, top: position.y + top,
		right: position.x + right, bottom: position.y + bottom,
	};
}

export function tileFootprint(position, tileWidth, tileHeight) {
	const width = Math.max(tileWidth, 1);
	const height = Math.max(tileHeight, 1);
	return {
		left: position.x - width / 2, top: position.y - height / 2,
		right: position.x + width / 2, bottom: position.y + height / 2,
	};
}

export function boxesOverlap(a, b) {
	return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

export function findOverlaps(placements) {
	const overlaps = [];
	for (let i = 0; i < placements.length; i++) {
		for (let j = i + 1; j < placements.length; j++) {
			const a = placements[i];
			const b = placements[j];
			if (boxesOverlap(a.collision_footprint, b.collision_footprint)) {
				overlaps.push({ a: a.type, b: b.type });
			}
		}
	}
	return overlaps;
}

export function cellFitFailure(placement) {
	const { cell, tile_footprint: box } = placement;
	if (box.left < cell.left) return `${placement.type} overhangs its cell to the west`;
	if (box.top < cell.top) return `${placement.type} overhangs its cell to the north`;
	if (box.right > cell.left + CELL_INNER.width) return `${placement.type} overhangs its cell to the east`;
	if (box.bottom > cell.top + CELL_INNER.height) return `${placement.type} overhangs its cell to the south`;
	return null;
}

function eligible(cell, rule) {
	if (!rule || !rule.edge) return true;
	if (rule.edge === "south") return cell.cellClass === "edge_south";
	if (rule.edge === "outward") return cell.cellClass === "edge_outward" || cell.cellClass === "edge_south";
	throw new Error(`placement rule names edge "${rule.edge}", which the allocator does not implement — `
		+ "an unenumerated edge would silently allocate an interior cell and lose the constraint");
}

export function allocate({ entries, columns, rows, origin, reserved = [], rules = loadPlacementRules() }) {
	const cells = cellsFor(columns, rows, origin);
	const taken = new Set();
	const placements = [];
	const unplaced = [];

	for (const { column, row } of reserved) {
		const index = cells.findIndex(cell => cell.column === column && cell.row === row);
		if (index === -1) throw new Error(`reserved cell ${column},${row} is not in a ${columns}x${rows} lattice`);
		taken.add(index);
	}

	const sorted = [...entries].sort((a, b) => a.type.localeCompare(b.type));
	const constrained = sorted.filter(entry => ruleFor(rules, entry.type)?.edge);
	const free = sorted.filter(entry => !ruleFor(rules, entry.type)?.edge);

	for (const entry of [...constrained, ...free]) {
		const rule = ruleFor(rules, entry.type);
		const cell = cells.find((candidate, index) => !taken.has(index) && eligible(candidate, rule));
		if (!cell) {
			unplaced.push({
				type: entry.type,
				reason: rule?.edge
					? `no free ${rule.edge}-edge cell remained for ${entry.type}`
					: `the ${columns}x${rows} lattice ran out of cells before ${entry.type}`,
			});
			continue;
		}
		taken.add(cells.indexOf(cell));

		const { tile_width: tileWidth, tile_height: tileHeight, collision_box: collisionBox } = entry.footprint;
		const position = positionIn(cell, tileWidth, tileHeight);
		placements.push({
			type: entry.type,
			name: entry.representative,
			cell,
			position,
			rule,
			collision_footprint: collisionFootprint(position, collisionBox),
			tile_footprint: tileFootprint(position, tileWidth, tileHeight),
		});
	}

	return { placements, unplaced, cells };
}

export function checkLayout(placements) {
	const failures = findOverlaps(placements)
		.map(pair => `${pair.a} and ${pair.b} have overlapping collision boxes`);
	for (const placement of placements) {
		const failure = cellFitFailure(placement);
		if (failure) failures.push(failure);
	}
	return failures;
}
