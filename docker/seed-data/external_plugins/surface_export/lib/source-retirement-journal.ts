import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface SourceRetirement {
	platformUid: string;
	exportId: string;
	platformIndex: number;
	surfaceIndex: number;
	forceName: string;
}

type Journal = { v: 1; id: string; retirements: SourceRetirement[] };

function validate(record: SourceRetirement): void {
	if (!record || typeof record.platformUid !== "string" || !record.platformUid
		|| typeof record.exportId !== "string" || !record.exportId
		|| typeof record.forceName !== "string" || !record.forceName
		|| !Number.isSafeInteger(record.platformIndex) || record.platformIndex < 1
		|| !Number.isSafeInteger(record.surfaceIndex) || record.surfaceIndex < 1) {
		throw new Error("Invalid source retirement identity");
	}
}

// This file belongs to the instance data directory, outside every Factorio save.
// Entries are not time-expired: a retained backup can resurrect a source indefinitely.
export class SourceRetirementJournal {
	private data?: Journal;
	private writes: Promise<void> = Promise.resolve();
	constructor(private readonly filename: string) {}

	async load(): Promise<void> {
		this.data = undefined;
		try {
			const data = JSON.parse(await fs.readFile(this.filename, "utf8")) as Journal;
			if (data.v !== 1 || typeof data.id !== "string" || !data.id || !Array.isArray(data.retirements)) {
				throw new Error("Invalid source retirement journal");
			}
			const identities = new Set<string>();
			for (const record of data.retirements) {
				validate(record);
				if (identities.has(record.platformUid)) throw new Error("Duplicate source retirement identity");
				identities.add(record.platformUid);
			}
			this.data = data;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const data: Journal = { v: 1, id: randomUUID(), retirements: [] };
			await this.write(data);
			this.data = data;
		}
	}

	snapshot(): Journal {
		if (!this.data) throw new Error("Source retirement journal is unavailable");
		return structuredClone(this.data);
	}

	async retire(record: SourceRetirement): Promise<void> {
		validate(record);
		const write = this.writes.then(async () => {
			const next = this.snapshot();
			const prior = next.retirements.find(entry => entry.platformUid === record.platformUid);
			if (prior) {
				if (prior.exportId !== record.exportId || prior.platformIndex !== record.platformIndex
					|| prior.surfaceIndex !== record.surfaceIndex || prior.forceName !== record.forceName) {
					throw new Error("Source retirement already belongs to another transfer");
				}
				return;
			}
			next.retirements.push({ ...record });
			await this.write(next);
			this.data = next;
		});
		// Keep serialization usable after a failed write; the caller still receives that failure.
		this.writes = write.catch(() => undefined);
		await write;
	}

	private async write(data: Journal): Promise<void> {
		await fs.mkdir(path.dirname(this.filename), { recursive: true });
		const temporary = `${this.filename}.tmp`;
		const file = await fs.open(temporary, "w");
		try { await file.writeFile(`${JSON.stringify(data)}\n`); await file.sync(); }
		finally { await file.close(); }
		await fs.rename(temporary, this.filename);
		// Linux instance volumes: persist the directory entry before authorizing deletion.
		if (process.platform !== "win32") {
			const directory = await fs.open(path.dirname(this.filename), "r");
			try { await directory.sync(); } finally { await directory.close(); }
		}
	}
}
