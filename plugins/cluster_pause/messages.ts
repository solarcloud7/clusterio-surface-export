import type { ClusterPauseState, ClusterPauseStatus } from "./shared/cluster-pause.js";
export type * from "./shared/cluster-pause.js";

const PLUGIN_NAME = "cluster_pause";

type JsonSchema = Record<string, unknown>;

export const PERMISSIONS = {
	VIEW: `${PLUGIN_NAME}.view`,
	CONTROL: `${PLUGIN_NAME}.control`,
} as const;

const INTEGER_LIST: JsonSchema = { type: "array", items: { type: "integer" } };

const STATE_PROPERTIES: Record<string, JsonSchema> = {
	phase: { enum: ["running", "countdown", "draining", "paused"] },
	sinceMs: { type: "number" },
	reason: { type: "string" },
	online: { type: "array", items: { type: "object" } },
	holds: { type: "array", items: { type: "object" } },
	confirmed: INTEGER_LIST,
	paused: INTEGER_LIST,
};

export class ClusterPauseRequest {
	declare ["constructor"]: typeof ClusterPauseRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "controller" as const;
	static dst = "instance" as const;
	static jsonSchema: JsonSchema = {
		type: "object", properties: { paused: { type: "boolean" } }, required: ["paused"], additionalProperties: false,
	};
	paused: boolean;
	constructor(json: { paused: boolean }) { this.paused = json.paused; }
	static fromJSON(json: { paused: boolean }) { return new ClusterPauseRequest(json); }
	toJSON() { return { paused: this.paused }; }
	static Response = {
		jsonSchema: { type: "object", properties: { paused: { type: "boolean" } }, required: ["paused"] } as JsonSchema,
		fromJSON(json: unknown) { return json as { paused: boolean }; },
	};
}

export class ClusterPauseStateEvent {
	declare ["constructor"]: typeof ClusterPauseStateEvent;
	static plugin = PLUGIN_NAME;
	static type = "event" as const;
	static src = "controller" as const;
	static dst = ["control", "instance"] as const;
	static permission = PERMISSIONS.VIEW;
	static jsonSchema: JsonSchema = {
		type: "object", properties: STATE_PROPERTIES, required: Object.keys(STATE_PROPERTIES), additionalProperties: false,
	};
	phase: ClusterPauseState["phase"];
	sinceMs: number;
	reason: ClusterPauseState["reason"];
	online: ClusterPauseState["online"];
	holds: ClusterPauseState["holds"];
	confirmed: number[];
	paused: number[];
	constructor(json: ClusterPauseState) {
		this.phase = json.phase;
		this.sinceMs = json.sinceMs;
		this.reason = json.reason;
		this.online = json.online;
		this.holds = json.holds;
		this.confirmed = json.confirmed;
		this.paused = json.paused;
	}
	static fromJSON(json: ClusterPauseState) { return new ClusterPauseStateEvent(json); }
	toJSON(): ClusterPauseState {
		return { phase: this.phase, sinceMs: this.sinceMs, reason: this.reason, online: this.online, holds: this.holds,
			confirmed: this.confirmed, paused: this.paused };
	}
}

export class ClusterPauseInstanceReadyEvent {
	declare ["constructor"]: typeof ClusterPauseInstanceReadyEvent;
	static plugin = PLUGIN_NAME;
	static type = "event" as const;
	static src = "instance" as const;
	static dst = "controller" as const;
	static jsonSchema: JsonSchema = { type: "object", properties: {}, additionalProperties: false };
	constructor(_json: Record<string, never> = {}) {}
	static fromJSON(_json: Record<string, never>) { return new ClusterPauseInstanceReadyEvent(); }
	toJSON() { return {}; }
}

const STATUS_RESPONSE = {
	jsonSchema: { type: "object", properties: { enabled: { type: "boolean" }, ...STATE_PROPERTIES }, required: ["enabled", "phase"] } as JsonSchema,
	fromJSON(json: unknown) { return json as ClusterPauseStatus; },
};

export class ClusterPauseStatusRequest {
	declare ["constructor"]: typeof ClusterPauseStatusRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "control" as const;
	static dst = "controller" as const;
	static permission = PERMISSIONS.VIEW;
	static jsonSchema: JsonSchema = { type: "object", properties: {}, additionalProperties: false };
	constructor(_json: Record<string, never> = {}) {}
	static fromJSON(_json: Record<string, never>) { return new ClusterPauseStatusRequest(); }
	toJSON() { return {}; }
	static Response = STATUS_RESPONSE;
}

export class ClusterPauseControlRequest {
	declare ["constructor"]: typeof ClusterPauseControlRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "control" as const;
	static dst = "controller" as const;
	static permission = PERMISSIONS.CONTROL;
	static jsonSchema: JsonSchema = {
		type: "object", properties: { action: { enum: ["pause", "resume"] } }, required: ["action"], additionalProperties: false,
	};
	action: "pause" | "resume";
	constructor(json: { action: "pause" | "resume" }) { this.action = json.action; }
	static fromJSON(json: { action: "pause" | "resume" }) { return new ClusterPauseControlRequest(json); }
	toJSON() { return { action: this.action }; }
	static Response = STATUS_RESPONSE;
}
