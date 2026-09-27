import fs from "fs/promises";
import * as lib from "@clusterio/lib";
import { enqueueWrite } from "./persist-queue";
import { getErrorMessage } from "../helpers";
import { PORTAL_SLOT_COUNT, portalColour } from "../shared/portals";

export const PORTAL_SLOTS_FILENAME = "surface_export_portal_slots.json";

type Logger = { info(message: string): void; warn(message: string): void; error(message: string): void };

export interface PortalHolderChange {
	slot: number;
	previousInstanceId: number;
	instanceId: number;
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
	private file: string | null = null;
	private dirty = false;
	private lastWaiting = "";
	private writing: Promise<void> = Promise.resolve();
	loadError: string | null = null;

	constructor(private readonly logger: Logger) {}

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

	reconcile(liveInstanceIds: readonly number[]): boolean {
		if (this.loadError) return false;
		const kept = assignPortalSlots(this.slots, [...this.slots.values()].filter(id => liveInstanceIds.includes(id)),
			new Set(Array.from({ length: PORTAL_SLOT_COUNT }, (_, index) => index + 1)));
		for (const [slot, instanceId] of this.slots) {
			if (kept.get(slot) !== instanceId) {
				this.logger.info(`Portal ${slot} retired: instance ${instanceId} no longer takes part`);
				this.released.set(slot, instanceId);
			}
		}
		const next = assignPortalSlots(kept, liveInstanceIds, new Set(this.released.keys()));
		const changed = JSON.stringify([...next]) !== JSON.stringify([...this.slots]);
		if (changed) {
			for (const [slot, instanceId] of next) {
				if (kept.get(slot) !== instanceId) this.logger.info(`Portal ${slot} assigned to instance ${instanceId}`);
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
		return changed;
	}

	async assign(slot: number, instanceId: number): Promise<PortalHolderChange[]> {
		this.assertWritable();
		const holder = this.slots.get(slot);
		if (holder === instanceId) return [];
		if (holder !== undefined) {
			throw new Error(`the ${portalColour(slot)} portal is held by instance ${holder}; release it first`);
		}
		const current = this.slotOf(instanceId);
		if (current !== null) {
			this.slots.delete(current);
			this.released.set(current, instanceId);
		}
		const previousInstanceId = this.released.get(slot);
		this.released.delete(slot);
		this.slots = new Map([...this.slots, [slot, instanceId] as [number, number]].sort((a, b) => a[0] - b[0]));
		this.logger.info(`Portal ${slot} assigned to instance ${instanceId} by an administrator`);
		await this.save();
		return previousInstanceId !== undefined && previousInstanceId !== instanceId ? [{ slot, previousInstanceId, instanceId }] : [];
	}

	async release(slot: number): Promise<number> {
		this.assertWritable();
		const holder = this.slots.get(slot);
		if (holder === undefined) throw new Error(`the ${portalColour(slot)} portal is not held by any server`);
		this.slots.delete(slot);
		this.released.set(slot, holder);
		this.logger.info(`Portal ${slot} released from instance ${holder} by an administrator`);
		await this.save();
		return holder;
	}

	retired(): Array<{ slot: number; previousInstanceId: number }> {
		return [...this.released].sort((a, b) => a[0] - b[0]).map(([slot, previousInstanceId]) => ({ slot, previousInstanceId }));
	}

	private assertWritable() {
		if (this.loadError) throw new Error(this.loadError);
	}

	private async save(): Promise<void> {
		this.dirty = true;
		this.writing = this.persist();
		await this.flush();
		if (this.dirty && this.file) throw new Error("the portal assignment changed but could not be saved; see the controller log");
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
