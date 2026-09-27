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

interface PortalState {
	slots: Map<number, number>;
	released: Map<number, number>;
}

function copyState(state: PortalState): PortalState {
	return { slots: new Map(state.slots), released: new Map(state.released) };
}

function sameState(a: PortalState, b: PortalState): boolean {
	const key = (state: PortalState) => JSON.stringify([[...state.slots].sort((x, y) => x[0] - y[0]), [...state.released].sort((x, y) => x[0] - y[0])]);
	return key(a) === key(b);
}

export class PortalSlots {
	private state: PortalState = { slots: new Map(), released: new Map() };
	private file: string | null = null;
	private lastWaiting = "";
	private lastWriteError = "";
	private queue: Promise<void> = Promise.resolve();
	private reconcileLive: readonly number[] | null = null;
	loadError: string | null = null;
	onCommitted?: () => void;

	constructor(private readonly logger: Logger) {}

	async load(file: string): Promise<void> {
		this.file = file;
		try {
			const saved: unknown = JSON.parse(await fs.readFile(file, "utf8"));
			if (!validSaved(saved)) throw new Error("not a version 1 list of distinct [slot, instance id] pairs");
			const slots = new Map(saved.slots);
			this.state = { slots, released: new Map((saved.released ?? []).filter(([slot]) => !slots.has(slot))) };
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
			this.loadError = `Portal colour assignments in ${file} are unreadable (${getErrorMessage(err)}); `
				+ "every coloured portal stays locked until the file is repaired or removed";
			this.logger.error(this.loadError);
		}
	}

	private reconciled(liveInstanceIds: readonly number[]): PortalState {
		const next = copyState(this.state);
		const kept = assignPortalSlots(next.slots, [...next.slots.values()].filter(id => liveInstanceIds.includes(id)),
			new Set(Array.from({ length: PORTAL_SLOT_COUNT }, (_, index) => index + 1)));
		for (const [slot, instanceId] of next.slots) {
			if (kept.get(slot) !== instanceId) next.released.set(slot, instanceId);
		}
		next.slots = assignPortalSlots(kept, liveInstanceIds, new Set(next.released.keys()));
		return next;
	}

	reconcile(liveInstanceIds: readonly number[]): boolean {
		if (this.loadError) return false;
		const next = this.reconciled(liveInstanceIds);
		const changed = !sameState(next, this.state);
		const waiting = [...new Set(liveInstanceIds)].filter(id => ![...next.slots.values()].includes(id)).sort((a, b) => a - b).join(",");
		if (waiting && waiting !== this.lastWaiting) {
			this.logger.warn(`No portal colour for instance(s) ${waiting}: at most ${PORTAL_SLOT_COUNT} servers take part in portal travel`);
		}
		this.lastWaiting = waiting;
		if (!changed) return false;
		if (!this.file) {
			this.apply(next);
			return true;
		}
		const queued = this.reconcileLive !== null;
		this.reconcileLive = [...liveInstanceIds];
		if (!queued) void this.enqueue(() => this.commitReconcile());
		return false;
	}

	private async commitReconcile(): Promise<void> {
		const live = this.reconcileLive ?? [];
		this.reconcileLive = null;
		const next = this.reconciled(live);
		if (sameState(next, this.state)) return;
		try {
			await this.write(next);
		} catch (err: unknown) {
			this.logger.warn(`Portal colour change for live instances ${live.join(",")} is not in effect: ${getErrorMessage(err)}`);
			return;
		}
		this.apply(next);
		this.onCommitted?.();
	}

	async settle(liveInstanceIds: readonly number[]): Promise<void> {
		this.reconcile(liveInstanceIds);
		await this.flush();
	}

	async assign(slot: number, instanceId: number): Promise<PortalHolderChange[]> {
		this.assertWritable();
		return this.enqueue(async () => {
			const next = copyState(this.state);
			const holder = next.slots.get(slot);
			if (holder === instanceId) return [];
			if (holder !== undefined) {
				throw new Error(`the ${portalColour(slot)} portal is held by instance ${holder}; release it first`);
			}
			for (const [held, id] of next.slots) {
				if (id === instanceId) {
					next.slots.delete(held);
					next.released.set(held, instanceId);
				}
			}
			const previousInstanceId = next.released.get(slot);
			next.released.delete(slot);
			next.slots.set(slot, instanceId);
			await this.write(next);
			this.apply(next);
			this.logger.info(`Portal ${slot} assigned to instance ${instanceId} by an administrator`);
			return previousInstanceId !== undefined && previousInstanceId !== instanceId ? [{ slot, previousInstanceId, instanceId }] : [];
		});
	}

	async release(slot: number): Promise<number> {
		this.assertWritable();
		return this.enqueue(async () => {
			const next = copyState(this.state);
			const holder = next.slots.get(slot);
			if (holder === undefined) throw new Error(`the ${portalColour(slot)} portal is not held by any server`);
			next.slots.delete(slot);
			next.released.set(slot, holder);
			await this.write(next);
			this.apply(next);
			this.logger.info(`Portal ${slot} released from instance ${holder} by an administrator`);
			return holder;
		});
	}

	retired(): Array<{ slot: number; previousInstanceId: number }> {
		return [...this.state.released].sort((a, b) => a[0] - b[0]).map(([slot, previousInstanceId]) => ({ slot, previousInstanceId }));
	}

	slotOf(instanceId: number): number | null {
		for (const [slot, holder] of this.state.slots) {
			if (holder === instanceId) return slot;
		}
		return null;
	}

	assignments(): Array<{ slot: number; instanceId: number }> {
		return [...this.state.slots].sort((a, b) => a[0] - b[0]).map(([slot, instanceId]) => ({ slot, instanceId }));
	}

	unassigned(liveInstanceIds: readonly number[]): number[] {
		return [...new Set(liveInstanceIds)].filter(instanceId => this.slotOf(instanceId) === null).sort((a, b) => a - b);
	}

	async flush(): Promise<void> {
		let pending: Promise<void>;
		do {
			pending = this.queue;
			await pending;
		} while (pending !== this.queue);
	}

	private assertWritable() {
		if (this.loadError) throw new Error(this.loadError);
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.queue.then(task);
		this.queue = run.then(() => undefined, () => undefined);
		return run;
	}

	private apply(next: PortalState) {
		for (const [slot, instanceId] of this.state.slots) {
			if (next.slots.get(slot) !== instanceId && next.released.get(slot) === instanceId) {
				this.logger.info(`Portal ${slot} retired: instance ${instanceId} no longer holds it`);
			}
		}
		for (const [slot, instanceId] of next.slots) {
			if (this.state.slots.get(slot) !== instanceId) this.logger.info(`Portal ${slot} now held by instance ${instanceId}`);
		}
		this.state = { slots: new Map([...next.slots].sort((a, b) => a[0] - b[0])), released: next.released };
	}

	private async write(next: PortalState): Promise<void> {
		const file = this.file;
		if (!file) return;
		const payload = JSON.stringify({ version: 1, slots: [...next.slots].sort((a, b) => a[0] - b[0]), released: [...next.released] });
		try {
			await enqueueWrite(file, () => lib.safeOutputFile(file, payload));
			this.lastWriteError = "";
		} catch (err: unknown) {
			const message = getErrorMessage(err);
			if (message !== this.lastWriteError) {
				this.logger.error(`Portal colour assignments could not be saved to ${file}: ${message}; the last saved assignment stays in effect`);
			}
			this.lastWriteError = message;
			throw new Error("the portal assignment could not be saved, so it was not applied; see the controller log");
		}
	}
}
