import { docker, instancePath, lua } from "../../../tests/lab-gallery/batch-lifecycle.mjs";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const DEFAULT_TOLERANCE = 2.0;

function decodePayload(raw) {
	const outer = typeof raw === "string" ? JSON.parse(raw) : raw;
	if (!outer.compressed) return outer.payload ? JSON.parse(outer.payload) : outer;
	if (outer.compression !== "deflate") {
		throw new Error(`unknown payload compression "${outer.compression}" — inspector needs updating`);
	}
	return JSON.parse(inflateSync(Buffer.from(outer.payload, "base64")).toString("utf8"));
}

function dig(object, path) {
	const keys = path.split(".");
	let cursor = object;
	for (let i = 0; i < keys.length; i++) {
		if (cursor === null || typeof cursor !== "object" || !(keys[i] in cursor)) {
			const availableKeys = (cursor && typeof cursor === "object") ? Object.keys(cursor) : [];
			const leaf = keys.at(-1);
			const hints = [];
			if (leaf in object) hints.push(leaf);
			for (const [k, v] of Object.entries(object)) {
				if (v && typeof v === "object" && !Array.isArray(v) && leaf in v) hints.push(`${k}.${leaf}`);
			}
			return { found: false, stoppedAt: keys.slice(0, i).join(".") || "(root)", availableKeys, pathHints: hints };
		}
		cursor = cursor[keys[i]];
	}
	return { found: true, value: cursor };
}

class PayloadInspector {
	constructor(payload, meta) {
		this.payload = payload;
		this.meta = meta;
		this.entities = payload.entities || [];
	}

	resolveAnchor({ entity, x, y }, tolerance = DEFAULT_TOLERANCE) {
		const sameName = this.entities.filter(e => e.name === entity && e.position);
		if (sameName.length === 0) {
			return { ok: false, reason: "no-such-entity-in-payload", record: null, candidates: 0 };
		}
		const ranked = sameName
			.map(e => ({ e, d: Math.hypot(e.position.x - x, e.position.y - y) }))
			.sort((a, b) => a.d - b.d);
		const [best, next] = ranked;
		if (best.d > tolerance) {
			return {
				ok: false, reason: "nearest-out-of-tolerance", record: null,
				delta: Number(best.d.toFixed(3)), nearestAt: best.e.position, candidates: sameName.length,
			};
		}
		const ambiguous = next !== undefined && Math.abs(next.d - best.d) < 1e-6;
		return {
			ok: true, record: best.e, delta: Number(best.d.toFixed(3)),
			ambiguous, candidates: sameName.length,
		};
	}

	field(anchor, fieldPath, tolerance = DEFAULT_TOLERANCE) {
		const hit = this.resolveAnchor(anchor, tolerance);
		if (!hit.ok) {
			return {
				anchorResolved: false, anchorReason: hit.reason, anchorDelta: hit.delta ?? null,
				inPayload: null, restorationTested: false, fieldPath,
			};
		}
		const found = dig(hit.record, fieldPath);
		const base = {
			anchorResolved: true, anchorDelta: hit.delta, anchorAmbiguous: hit.ambiguous,
			resolvedName: hit.record.name, inPayload: found.found,
			restorationTested: false, fieldPath,
		};
		if (found.found) return { ...base, value: found.value };
		return {
			...base,
			stoppedAt: found.stoppedAt,
			availableKeys: found.availableKeys,
			pathHints: found.pathHints,
		};
	}

	countsByType() {
		const counts = {};
		for (const e of this.entities) counts[e.type] = (counts[e.type] || 0) + 1;
		return counts;
	}

	summary() {
		const schedule = this.payload.platform && this.payload.platform.schedule;
		return {
			platform: this.payload.platform_name,
			schemaVersion: this.payload.schema_version,
			factorioVersion: this.payload.factorio_version,
			entities: this.entities.length,
			tiles: (this.payload.tiles || []).length,
			fluidSegments: (this.payload.fluid_segments || []).length,
			scheduleRecords: schedule ? (schedule.records || schedule.stations || []).length : null,
			scheduleInterrupts: schedule ? (schedule.interrupts || []).length : null,
			bytes: this.meta.bytes,
		};
	}
}

async function waitForStableFile(host, path, timeoutMs, settleMs = 400) {
	const container = `surface-export-host-${host}`;
	const deadline = Date.now() + timeoutMs;
	let lastSize = -1, stableSince = 0;
	while (Date.now() < deadline) {
		const out = docker(["exec", container, "sh", "-c", `stat -c %s ${path} 2>/dev/null || echo absent`]).trim();
		if (out !== "absent") {
			const size = Number(out);
			if (size > 0 && size === lastSize) {
				if (stableSince && Date.now() - stableSince >= settleMs) return size;
				if (!stableSince) stableSince = Date.now();
			} else {
				stableSince = 0;
			}
			lastSize = size;
		}
		await new Promise(resolve => setTimeout(resolve, 200));
	}
	throw new Error(`export artifact ${path} never stabilised within ${timeoutMs}ms ` +
		`(last size ${lastSize === -1 ? "absent" : lastSize}) — the export job may have failed; ` +
		`check the instance log rather than treating this as an empty payload`);
}

export async function exportInspect({ platform, host = 1, force = "player", keepArtifact = false,
	timeoutMs = 120_000 }) {
	if (!platform) throw new Error("exportInspect needs { platform }");
	const index = resolvePlatformIndex(host, platform, force);
	const filename = `testkit_inspect_${String(platform).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
	const artifact = instancePath(host, `script-output/${filename}`);

	docker(["exec", `surface-export-host-${host}`, "sh", "-c", `rm -f ${artifact}`]);

	const exported = lua(host, `return {success=remote.call('surface_export','export_platform_to_file',` +
		`${index},'${force}','${filename}')}`);
	if (exported.success !== true) {
		throw new Error(`export_platform_to_file failed for ${platform}: ${JSON.stringify(exported)}`);
	}

	await waitForStableFile(host, artifact, timeoutMs);

	const raw = docker(["exec", `surface-export-host-${host}`, "sh", "-c", `cat ${artifact}`],
		{ maxBuffer: 256 * 1024 * 1024 });
	if (!keepArtifact) {
		docker(["exec", `surface-export-host-${host}`, "sh", "-c", `rm -f ${artifact}`]);
	}
	return new PayloadInspector(decodePayload(raw), { bytes: raw.length, artifact: keepArtifact ? artifact : null });
}

export function inspectPayloadFile(path) {
	const raw = readFileSync(path, "utf8");
	return new PayloadInspector(decodePayload(raw), { bytes: raw.length, artifact: path });
}

export function inspectPayloadObject(payload) {
	return new PayloadInspector(payload, { bytes: null, artifact: null });
}

export function resolvePlatformIndex(host, name, force = "player") {
	const found = lua(host, `local out={} for _,p in pairs(game.forces['${force}'].platforms or {}) do ` +
		`if p.name=='${name}' then out[#out+1]=p.index end end return {success=true,indices=out}`);
	const indices = Array.isArray(found.indices) ? found.indices : Object.values(found.indices || {});
	if (indices.length === 0) throw new Error(`no platform named "${name}" on force ${force} (host ${host})`);
	if (indices.length > 1) {
		throw new Error(`platform name "${name}" is ambiguous on force ${force}: indices ${indices.join(", ")} — ` +
			`names collide, pass an index instead`);
	}
	return indices[0];
}
