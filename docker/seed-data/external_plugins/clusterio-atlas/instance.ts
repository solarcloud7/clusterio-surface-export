/**
 * @file instance.ts
 * @description Receives per-chunk map data over Clusterio IPC and lands it in the
 * atlas Postgres (dedup + idempotent upsert). Loose execution: if the database is
 * unreachable, captures are buffered to disk and drained on the next success.
 */

import { BaseInstancePlugin } from "@clusterio/host";
import { Pool } from "pg";
import crypto from "node:crypto";
import fs from "node:fs/promises";

interface Ent {
	name: string;
	type: string;
	x: number;
	y: number;
	dir?: number;
	force?: string;
	amount?: number;
	recipe?: string;
}

interface ChunkMsg {
	surface: string;
	cx: number;
	cy: number;
	entities: Ent[];
}

export class InstancePlugin extends BaseInstancePlugin {
	private pg!: Pool;
	private schemaReady = false;
	private draining = false;
	private bufferPath!: string;

	/** Read a config key that isn't in InstanceConfig's strict field union (our custom keys). */
	private cfg<T = unknown>(key: string): T {
		return (this.instance.config as { get(k: string): unknown }).get(key) as T;
	}

	async init() {
		const dsn = this.cfg<string>("clusterio_atlas.atlas_pg_dsn") || process.env.ATLAS_PG_DSN || "";
		this.pg = new Pool({ connectionString: dsn });
		this.bufferPath = this.instance.path("atlas_buffer.jsonl");

		// Best-effort: a DB outage at startup must not stop the plugin from loading.
		// Schema is (re)ensured lazily on the first successful ingest, and any
		// buffered captures drain then.
		await this.ensureReady().catch(err =>
			this.logger.warn(`atlas: database not ready at init, will retry on ingest: ${err.message}`));

		// Channel name MUST equal the Lua `send_json` channel — no `ipc-` prefix.
		this.instance.server.handle("atlas_chunk", async (d: ChunkMsg) => {
			try {
				await this.ingest(d);
			} catch (err) {
				this.logger.error(`atlas ingest failed:\n${(err as Error).stack}`);
			}
		});

		this.logger.info("Clusterio Atlas plugin initialized");
	}

	private async ensureReady() {
		if (!this.schemaReady) {
			await this.ensureSchema();
			this.schemaReady = true;
		}
		await this.drainBuffer();
	}

	private async ensureSchema() {
		await this.pg.query(`
			CREATE TABLE IF NOT EXISTS chunks (
				surface TEXT NOT NULL, cx INT NOT NULL, cy INT NOT NULL,
				content_hash BYTEA NOT NULL, entity_count INT NOT NULL DEFAULT 0,
				updated_at TIMESTAMPTZ DEFAULT now(),
				PRIMARY KEY (surface, cx, cy));
			CREATE TABLE IF NOT EXISTS entities (
				id BIGSERIAL PRIMARY KEY, surface TEXT NOT NULL, cx INT NOT NULL, cy INT NOT NULL,
				name TEXT NOT NULL, type TEXT NOT NULL, force TEXT, direction SMALLINT,
				x DOUBLE PRECISION NOT NULL, y DOUBLE PRECISION NOT NULL, props JSONB,
				updated_at TIMESTAMPTZ DEFAULT now());
			CREATE INDEX IF NOT EXISTS entities_surface_cxcy ON entities(surface, cx, cy);
			CREATE INDEX IF NOT EXISTS entities_surface_name ON entities(surface, name);`);
	}

	/** Hash a CANONICAL entity list (sorted) — not the raw payload order — so dedup is stable. */
	private hash(es: Ent[]): Buffer {
		const sorted = [...es].sort((a, b) =>
			a.name.localeCompare(b.name) || a.x - b.x || a.y - b.y || (a.dir ?? 0) - (b.dir ?? 0));
		return crypto.createHash("sha256").update(JSON.stringify(sorted)).digest();
	}

	async ingest(d: ChunkMsg) {
		try {
			await this.ensureReady();
			await this.writeChunk(d);
		} catch (err) {
			// Loose execution: never drop a capture because the DB is down — buffer to
			// disk; it drains on the next successful ingest. Rethrow so the failure is logged.
			await this.buffer(d);
			throw err;
		}
	}

	private async writeChunk(d: ChunkMsg) {
		const h = this.hash(d.entities);
		const cur = await this.pg.query(
			"SELECT content_hash FROM chunks WHERE surface=$1 AND cx=$2 AND cy=$3",
			[d.surface, d.cx, d.cy]);
		if (cur.rows[0] && Buffer.compare(cur.rows[0].content_hash, h) === 0) {
			return; // unchanged → skip (dedup)
		}

		const c = await this.pg.connect();
		try {
			await c.query("BEGIN");
			await c.query(
				`INSERT INTO chunks(surface, cx, cy, content_hash, entity_count)
				 VALUES($1, $2, $3, $4, $5)
				 ON CONFLICT (surface, cx, cy) DO UPDATE
				   SET content_hash = EXCLUDED.content_hash,
				       entity_count = EXCLUDED.entity_count,
				       updated_at = now()`,
				[d.surface, d.cx, d.cy, h, d.entities.length]);
			await c.query("DELETE FROM entities WHERE surface=$1 AND cx=$2 AND cy=$3",
				[d.surface, d.cx, d.cy]);
			for (const e of d.entities) {
				await c.query(
					`INSERT INTO entities(surface, cx, cy, name, type, force, direction, x, y, props)
					 VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
					[d.surface, d.cx, d.cy, e.name, e.type, e.force ?? null, e.dir ?? null, e.x, e.y,
						JSON.stringify({ amount: e.amount, recipe: e.recipe })]);
			}
			await c.query("COMMIT");
		} catch (err) {
			await c.query("ROLLBACK").catch(() => {});
			throw err;
		} finally {
			c.release();
		}
	}

	private async buffer(d: ChunkMsg) {
		try {
			await fs.appendFile(this.bufferPath, JSON.stringify(d) + "\n");
		} catch (err) {
			this.logger.error(`atlas: failed to buffer capture to disk: ${(err as Error).message}`);
		}
	}

	private async drainBuffer() {
		if (this.draining) return;
		this.draining = true;
		try {
			let raw: string;
			try {
				raw = await fs.readFile(this.bufferPath, "utf8");
			} catch {
				return; // no buffer file → nothing to drain
			}
			const lines = raw.split("\n").filter(Boolean);
			if (!lines.length) {
				await fs.rm(this.bufferPath, { force: true });
				return;
			}

			const failed: string[] = [];
			for (const line of lines) {
				try {
					await this.writeChunk(JSON.parse(line) as ChunkMsg);
				} catch {
					failed.push(line); // keep poison/blocked items for the next attempt
				}
			}
			if (failed.length) {
				await fs.writeFile(this.bufferPath, failed.join("\n") + "\n");
			} else {
				await fs.rm(this.bufferPath, { force: true });
			}
			const drained = lines.length - failed.length;
			if (drained > 0) {
				this.logger.info(`atlas: drained ${drained} buffered chunk(s) to the database`);
			}
		} finally {
			this.draining = false;
		}
	}

	async onStop() {
		await this.pg?.end().catch(() => {});
	}
}
