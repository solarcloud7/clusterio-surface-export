import { deflate, inflate } from "node:zlib";
import { promisify } from "node:util";
import { timed, timedSync } from "./timing";

const compress = promisify(deflate);
const decompress = promisify(inflate);
const FRAME_BYTES = 65536;
const MAX_FRAMES = 4096;
const MAX_DOCUMENT_BYTES = 256 * 1024 * 1024;
const arrays = new Set(["entities", "tiles", "belt_side_groups"]);
const routing = ["_transferId", "_sourceInstanceId", "_operationId", "_targetPlanet"];
type ObjectData = Record<string, unknown>;
function object(value: unknown): value is ObjectData {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function inflateJson(encoded: unknown, limit: number): Promise<unknown> {
	if (typeof encoded !== "string" || encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded)
		|| Buffer.from(encoded, "base64").toString("base64") !== encoded) {
		throw new Error("Invalid deflate/base64 payload");
	}
	const raw = await timed("Payload decompression", "inclusive", () => decompress(Buffer.from(encoded, "base64"), { maxOutputLength: limit }));
	return timedSync("Payload JSON decoding", () => JSON.parse(raw.toString("utf8")));
}

/** Convert internal source frames back into the existing downloadable artifact. */
export async function normalizeSectionExport(value: ObjectData): Promise<ObjectData> {
	if (value.section_codec === undefined) return value;
	if (value.section_codec !== 1 || !Array.isArray(value.sections) || value.sections.length < 1 || value.sections.length > MAX_FRAMES || value.section_count !== value.sections.length) {
		throw new Error("Invalid section envelope");
	}
	const data: ObjectData = Object.create(null);
	const arrayFields = new Set<string>();
	for (let index = 0; index < value.sections.length; index++) {
		const frame = await inflateJson(value.sections[index], FRAME_BYTES);
		if (!object(frame) || frame.version !== 1 || frame.seq !== index + 1 || typeof frame.key !== "string" || frame.key.length > 256) {
			throw new Error("Invalid section identity or sequence");
		}
		const key = frame.key;
		if (frame.first !== undefined) {
			if (!arrays.has(key) || frame.value !== undefined || !Array.isArray(frame.values) || !frame.values.length
				|| !frame.values.every(object) || (Object.hasOwn(data, key) && !arrayFields.has(key))) throw new Error("Invalid array section");
			const target = (data[key] ??= []) as unknown[];
			if (frame.first !== target.length + 1) throw new Error("Invalid section range");
			for (const entry of frame.values) target.push(entry);
			arrayFields.add(key);
		} else {
			if (!Object.hasOwn(frame, "value") || frame.value === null || frame.values !== undefined || Object.hasOwn(data, key)) throw new Error("Duplicate or missing section value");
			data[key] = frame.value;
		}
	}
	const json = timedSync("Artifact JSON encoding", () => JSON.stringify(data));
	const payload = await timed("Artifact compression", "inclusive", () => compress(json));
	return { compressed: true, compression: "deflate", payload: payload.toString("base64"),
		platform_name: data.platform_name, tick: data.tick, timestamp: data.timestamp, stats: data.stats, verification: data.verification };
}

/** Legacy artifacts remain unchanged; oversized individual records use that path. */
export async function prepareSectionImport(original: ObjectData): Promise<ObjectData> {
	const data = original.compressed && original.payload ? await inflateJson(original.payload, MAX_DOCUMENT_BYTES) : original;
	if (!object(data)) throw new Error("Import payload must be an object");
	const frames: string[] = [];
	const emit = (key: string, content: ObjectData) => {
		const text = JSON.stringify({ version: 1, seq: frames.length + 1, key, ...content });
		if (Buffer.byteLength(text) > FRAME_BYTES || frames.length >= MAX_FRAMES) return false;
		frames.push(text); return true;
	};
	for (const key of Object.keys(data).sort()) {
		const value = data[key];
		if (value === null || value === undefined) return original;
		if (!arrays.has(key) || !Array.isArray(value) || !value.length) {
			if (!emit(key, { value })) return original;
			continue;
		}
		let first = 1, bytes = 0, entries: unknown[] = [];
		for (const entry of value) {
			const size = Buffer.byteLength(JSON.stringify(entry));
			if (entries.length && bytes + size > 60000) {
				if (!emit(key, { first, values: entries })) return original;
				first += entries.length; entries = []; bytes = 0;
			}
			entries.push(entry); bytes += size + 1;
		}
		if (!emit(key, { first, values: entries })) return original;
	}
	const sections: string[] = [];
	// Bound compression concurrency and memory rather than submitting thousands of workers.
	for (const frame of frames) sections.push((await compress(frame)).toString("base64"));
	const result: ObjectData = { section_codec: 1, section_count: sections.length, sections };
	for (const key of routing) if (original[key] !== undefined) result[key] = original[key];
	return result;
}
