export interface BeltDifference {
	entityId: number; name: string; x: number; y: number; line: number;
	item: string; expected: number; actual: number; delta: number;
}
export interface EntityEvidence {
	status: "available" | "unavailable"; file: string; reason?: string;
	rows: BeltDifference[]; totalRows: number; truncated: boolean;
}
