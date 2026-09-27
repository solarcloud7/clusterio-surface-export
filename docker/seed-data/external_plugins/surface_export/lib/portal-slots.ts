import fs from "fs/promises";
import * as lib from "@clusterio/lib";
import { enqueueWrite } from "./persist-queue";
import { getErrorMessage } from "../helpers";
import { PORTAL_SLOT_COUNT } from "../shared/portals";

export const PORTAL_SLOTS_FILENAME = "surface_export_portal_slots.json";

type Logger = { info(message: string): void; warn(message: string): void; error(message: string): void };

export interface PortalHolderChange {
	slot: number;
	previousInstanceId: number;
	instanceId: number;
}

export interface PortalSlotsOptions {
	reuseFreedColours?: boolean;
}

export function assignPortalSlots(
	current: ReadonlyMap<number, number>,
	liveInstanceIds: readonly number[],
	withheldSlots: ReadonlySet<number> = new Set(),
): Map<number, number> {
	const live = new Set(liveInstanceIds);
	const kept = new Map<number, number>();
	const holding = new Set<number>();
	for (const [slot, instanceId] of [...current].sort((a, b) => a[0] - b[0])) {
		if (slot >= 1 && slot <= PORTAL_SLOT_COUNT && live.has(instanceId) && !holding.has(instanceId)) {
			kept.set(slot, instanceId);
			holding.add(instanceId);
		}
	}
	const waiting = [...live].filter(instanceId => !holding.has(instanceId)).sort((a, b) => a - b);
	for (let slot = 1; slot <= PORTAL_SLOT_COUNT && waiting.length > 0; slot += 1) {
		if (!kept.has(slot) && !withheldSlots.has(slot)) {
			kept.set(slot, waiting.shift() as number);
		}
	}
	return new Map([...kept].sort((a, b) => a[0] - b[0]));
}

function validPairs(value: unknown, distinctInstances: boolean): value is Array<[number, number]> {
	if (!Array.isArray(value)) return false;
	const slots = new Set<number>(), instances = new Set<number>();
	for (const entry of value) {
		if (!Array.isArray(entry) || entry.length !== 2) return false;
		const [slot, instanceId] = entry as unknown[];
		if (!Number.isInteger(slot) || (slot as number) < 1 || (slot as number) > PORTAL_SLOT_COUNT) return false;
		if (!Number.isSafeInteger(instanceId) || slots.has(slot as number)) return false;
		if (distinctInstances && instances.has(instanceId as number)) return false;
		slots.add(slot as number);
		instances.add(instanceId as number);
	}
	return true;
}

function validSaved(saved: unknown): saved is { version: 1; slots: Array<[number, number]>; released?: Array<[number, number]> } {
	const value = saved as { version?: unknown; slots?: unknown; released?: unknown };
	return value?.version === 1 && validPairs(value.slots, true) && (value.released === undefined || validPairs(value.released, false));
}

export class PortalSlots {
	private slots = new Map<number, number>();
	private released = new Map<number, number>();
	private readonly reuseFreedColours: boolean;
	private file: string | null = null;
	private dirty = false;
	private lastWaiting = "";
	private writing: Promise<void> = Promise.resolve();
	loadError: string | null = null;

	constructor(private readonly logger: Logger, options: PortalSlotsOptions = {}) {
		this.reuseFreedColours = options.reuseFreedColours !== false;
	}

	async load(file: string): Promise<void> {
		this.file = file;
		try {
			const saved: unknown = JSON.parse(await fs.readFile(file, "utf8"));
			if (!validSaved(saved)) throw new Error("not a version 1 list of distinct [slot, instance id] pairs");
			this.slots = new Map(saved.slots);
			this.released = new Map((saved.released ?? []).filter(([slot]) => !this.slots.has(slot)));
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
			this.loadError = `Portal colour assignments in ${file} are unreadable (${getErrorMessage(err)}); `
				+ "every coloured portal stays locked until the file is repaired or removed";
			this.logger.error(this.loadError);
		}
	}

	reconcile(liveInstanceIds: readonly number[]): PortalHolderChange[] {
		if (this.loadError) return [];
		const withheld = this.reuseFreedColours ? new Set<number>() : new Set(this.released.keys());
		const next = assignPortalSlots(this.slots, liveInstanceIds, withheld);
		const changes: PortalHolderChange[] = [];
		if (JSON.stringify([...next]) !== JSON.stringify([...this.slots])) {
			for (const [slot, instanceId] of this.slots) {
				if (next.get(slot) !== instanceId) {
					this.logger.info(`Portal ${slot} released by instance ${instanceId}`);
					this.released.set(slot, instanceId);
				}
			}
			for (const [slot, instanceId] of next) {
				if (this.slots.get(slot) === instanceId) continue;
				this.logger.info(`Portal ${slot} assigned to instance ${instanceId}`);
				const previousInstanceId = this.released.get(slot);
				if (previousInstanceId !== undefined && previousInstanceId !== instanceId) {
					changes.push({ slot, previousInstanceId, instanceId });
				}
				this.released.delete(slot);
			}
			this.slots = next;
			this.dirty = true;
		}
		const waiting = this.unassigned(liveInstanceIds).join(",");
		if (waiting && waiting !== this.lastWaiting) {
			this.logger.warn(`No portal colour for instance(s) ${waiting}: at most ${PORTAL_SLOT_COUNT} servers take part in portal travel`);
		}
		this.lastWaiting = waiting;
		if (this.dirty) this.writing = this.persist();
		return changes;
	}

	slotOf(instanceId: number): number | null {
		for (const [slot, holder] of this.slots) {
			if (holder === instanceId) return slot;
		}
		return null;
	}

	assignments(): Array<{ slot: number; instanceId: number }> {
		return [...this.slots].map(([slot, instanceId]) => ({ slot, instanceId }));
	}

	unassigned(liveInstanceIds: readonly number[]): number[] {
		return [...new Set(liveInstanceIds)].filter(instanceId => this.slotOf(instanceId) === null).sort((a, b) => a - b);
	}

	async flush(): Promise<void> {
		let pending: Promise<void>;
		do {
			pending = this.writing;
			await pending;
		} while (pending !== this.writing);
	}

	private async persist(): Promise<void> {
		const file = this.file;
		this.dirty = false;
		if (!file || this.loadError) return;
		const payload = JSON.stringify({ version: 1, slots: [...this.slots], released: [...this.released] });
		try {
			await enqueueWrite(file, () => lib.safeOutputFile(file, payload));
		} catch (err: unknown) {
			this.dirty = true;
			this.logger.error(`Portal colour assignments could not be saved to ${file}: ${getErrorMessage(err)}`);
		}
	}
}
