import type {
	PlatformModel,
	StoredExportSummaryModel,
	TransactionLogEntryModel,
	TransferSummaryModel,
	ExportMetrics,
	ImportMetrics,
	PayloadMetrics,
	ValidationResult,
	ResolvedGateway,
	PassengerCarry,
	PassengerManifestEntry,
	AuditRow,
	PortalListingResponse,
} from "./shared/dto";
export type {
	HostNodeModel,
	InstanceNodeModel,
	PlatformModel,
	StoredExportSummaryModel,
	TransactionLogEntryModel,
	TransferSummaryModel,
	ExportMetrics,
	ImportMetrics,
	PayloadMetrics,
	PhaseSpan,
	ValidationResult,
	ResolvedGatewayTarget,
	ResolvedGateway,
	PassengerCarry,
	PassengerManifestEntry,
	AuditRow,
	PortalListing,
	PortalListingResponse,
} from "./shared/dto";
export {
	GATEWAY_PREFIX,
	ONE_GATE_NAME,
	ONE_GATE_NAMES,
} from "./shared/dto";
import type { TimingRecord, OperationTiming } from "./shared/timing";
const PLUGIN_NAME = "surface_export";

export class OperationTimingEvent {
	declare ["constructor"]: typeof OperationTimingEvent;
	static plugin = PLUGIN_NAME;
	static type = "event" as const;
	static src = "instance" as const;
	static dst = "controller" as const;
	static jsonSchema: JsonSchema = { type: "object", properties: { record: { type: "object" } }, required: ["record"], additionalProperties: false };
	constructor(public record: TimingRecord) {}
	toJSON() { return { record: this.record }; }
	static fromJSON(json: { record: TimingRecord }) { return new this(json.record); }
}


export const PERMISSIONS = {
	LIST_EXPORTS: `${PLUGIN_NAME}.exports.list`,
	TRANSFER_EXPORTS: `${PLUGIN_NAME}.exports.transfer`,
	UI_VIEW: `${PLUGIN_NAME}.ui.view`,
	VIEW_LOGS: `${PLUGIN_NAME}.logs.view`,
	RECOVERY_RESOLVE: `${PLUGIN_NAME}.recovery.resolve`,
} as const;


type JsonSchema = Record<string, unknown>;

export interface SimpleResponse {
	success: boolean;
	error?: string;
}

export const SOURCE_TRANSFER_LOCK_STATES = [
	"pre_commit",
	"committed",
	"source_gone_matching_transfer",
	"unknown/offline",
	"identity_mismatch",
	"unlocked",
	"source_missing",
] as const;
export type SourceTransferLockState = typeof SOURCE_TRANSFER_LOCK_STATES[number];
export interface SourceTransferLockStateResponse {
	state: SourceTransferLockState;
	transferId: string | null;
	error: string | null;
}

export class ExportPlatformRequest {
	declare ["constructor"]: typeof ExportPlatformRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = ["controller", "instance"] as const;
	static dst = "instance" as const;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: {
			platformIndex: { type: "integer" },
			platformUid: { type: "string", minLength: 1 },
			operationId: { type: "string" },
			forceName: { type: "string", default: "player" },
			targetInstanceId: { type: ["integer", "null"], default: null },
		},
		required: ["platformIndex"],
		additionalProperties: false,
	};

	operationId?: string;
	platformIndex: number;
	platformUid?: string;
	forceName: string;
	targetInstanceId: number | null;

	constructor(json: { platformUid?: string; operationId?: string; platformIndex: number; forceName?: string; targetInstanceId?: number | null }) {
		this.operationId = json.operationId;
		this.platformIndex = json.platformIndex;
		this.platformUid = json.platformUid;
		this.forceName = json.forceName || "player";
		this.targetInstanceId = json.targetInstanceId ?? null;
	}

	static fromJSON(json: { platformUid?: string; operationId?: string; platformIndex: number; forceName?: string; targetInstanceId?: number | null }) {
		return new ExportPlatformRequest(json);
	}

	toJSON() {
		return { platformUid: this.platformUid, operationId: this.operationId, platformIndex: this.platformIndex, forceName: this.forceName, targetInstanceId: this.targetInstanceId };
	}

	static Response = {
		jsonSchema: {
			type: "object",
			properties: {
				success: { type: "boolean" },
				exportId: { type: "string" },
				admissionUncertain: { type: "boolean" },
				error: { type: "string" },
			},
			required: ["success"],
		} as JsonSchema,
		fromJSON(json: unknown) { return json as SimpleResponse & { exportId?: string }; },
	};
}

export class RecoveryPolicyRequest {
	declare ["constructor"]: typeof RecoveryPolicyRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "instance" as const;
	static dst = "controller" as const;
	static jsonSchema: JsonSchema = {
		type: "object", properties: { instanceId: { type: "integer" }, epoch: { type: "string" }, action: { type: "string" } },
		required: ["instanceId", "epoch", "action"], additionalProperties: false,
	};
	instanceId: number;
	epoch: string;
	action: string;
	constructor(json: { instanceId: number; epoch: string; action: string }) {
		this.instanceId = json.instanceId; this.epoch = json.epoch; this.action = json.action;
	}
	static fromJSON(json: { instanceId: number; epoch: string; action: string }) { return new RecoveryPolicyRequest(json); }
	toJSON() { return { instanceId: this.instanceId, epoch: this.epoch, action: this.action }; }
	static Response = {
		jsonSchema: { type: "object", properties: { mode: { type: "string" }, allowAdoption: { type: "boolean" },
			protectedSourceIndexes: {type: "array", items: {type: "integer"}} }, required: ["mode", "allowAdoption"] } as JsonSchema,
		fromJSON(json: unknown) { return json as { mode: import("./shared/recovery").PlatformSourceOfTruth; allowAdoption: boolean; protectedSourceIndexes?: number[] }; },
	};
}

const LINEAGE_SCHEMA = { type: "string", maxLength: 200, pattern: "^lineage:[^:\\s]+:[1-9][0-9]*$" };
const PLATFORM_FACTS_SCHEMA = {
	type: "object",
	properties: {
		platformIndex: { type: "integer" }, platformUid: { type: ["string", "null"] }, hadIdentity: { type: "boolean" },
		lineage: { anyOf: [LINEAGE_SCHEMA, { type: "null" }] }, generation: { type: ["integer", "null"], minimum: 0 },
		hubUnitNumber: { type: ["integer", "null"] }, surfaceIndex: { type: ["integer", "null"] },
		platformName: { type: ["string", "null"] }, forceName: { type: ["string", "null"] }, lockKind: { type: ["string", "null"] },
		jobOwns: { type: "boolean" }, journalUidMatch: { type: "boolean" }, journalHubMatch: { type: "boolean" }, protected: { type: "boolean" },
	},
	required: ["platformIndex", "platformUid", "hadIdentity", "lineage", "generation", "hubUnitNumber", "surfaceIndex",
		"platformName", "forceName", "lockKind", "jobOwns", "journalUidMatch", "journalHubMatch", "protected"],
	additionalProperties: false,
};

export class LineageClassifyRequest {
	declare ["constructor"]: typeof LineageClassifyRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "instance" as const;
	static dst = "controller" as const;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: { instanceId: { type: "integer" }, epoch: { type: "string" }, platforms: { type: "array", maxItems: 500, items: PLATFORM_FACTS_SCHEMA } },
		required: ["instanceId", "epoch", "platforms"], additionalProperties: false,
	} as JsonSchema;
	instanceId: number;
	epoch: string;
	platforms: import("./shared/lineage").PlatformFacts[];
	constructor(json: { instanceId: number; epoch: string; platforms: import("./shared/lineage").PlatformFacts[] }) {
		this.instanceId = json.instanceId; this.epoch = json.epoch; this.platforms = json.platforms;
	}
	static fromJSON(json: { instanceId: number; epoch: string; platforms: import("./shared/lineage").PlatformFacts[] }) { return new LineageClassifyRequest(json); }
	toJSON() { return { instanceId: this.instanceId, epoch: this.epoch, platforms: this.platforms }; }
	static Response = {
		jsonSchema: { type: "object", properties: { verdicts: { type: "array", maxItems: 500, items: { type: "object" } } }, required: ["verdicts"] } as JsonSchema,
		fromJSON(json: unknown) { return json as { verdicts: import("./shared/lineage").LineageVerdict[] }; },
	};
}

export class LineagePresenceRequest {
	declare ["constructor"]: typeof LineagePresenceRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "controller" as const;
	static dst = "instance" as const;
	static jsonSchema: JsonSchema = {
		type: "object", properties: { lineages: { type: "array", maxItems: 500, items: LINEAGE_SCHEMA } },
		required: ["lineages"], additionalProperties: false,
	} as JsonSchema;
	lineages: string[];
	constructor(json: { lineages: string[] }) { this.lineages = json.lineages; }
	static fromJSON(json: { lineages: string[] }) { return new LineagePresenceRequest(json); }
	toJSON() { return { lineages: this.lineages }; }
	static Response = {
		jsonSchema: { type: "object", properties: { success: { type: "boolean" }, epoch: { type: "string" }, error: { type: "string" },
			lineages: { type: "array", items: { type: "object", properties: { lineage: LINEAGE_SCHEMA, present: { type: "boolean" },
				generation: { type: "integer" }, held: { type: "boolean" }, platformIndex: { type: "integer" }, platformUid: { type: "string" },
				platformName: { type: "string" }, forceName: { type: "string" }, passengers: { type: "integer", minimum: 0 } },
				required: ["lineage", "present"] } } }, required: ["success"] } as JsonSchema,
		fromJSON(json: unknown) { return json as { success: boolean; epoch?: string; error?: string; lineages?: Array<{ lineage: string; present: boolean; generation?: number; held?: boolean; platformIndex?: number; platformUid?: string; platformName?: string; forceName?: string; passengers?: number }> }; },
	};
}

const REQUEST_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$";

export class ListLineageConflictsRequest {
	declare ["constructor"]: typeof ListLineageConflictsRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "control" as const;
	static dst = "controller" as const;
	static permission = PERMISSIONS.UI_VIEW;
	static jsonSchema: JsonSchema = {
		type: "object", properties: { instanceId: { type: ["integer", "null"] } }, additionalProperties: false,
	};
	instanceId: number | null;
	constructor(json: { instanceId?: number | null } = {}) { this.instanceId = json.instanceId ?? null; }
	static fromJSON(json: { instanceId?: number | null }) { return new ListLineageConflictsRequest(json); }
	toJSON() { return { instanceId: this.instanceId }; }
	static Response = {
		jsonSchema: { type: "object", properties: { conflicts: { type: "array", items: { type: "object" } },
			unavailable: { type: "array", items: { type: "object" } }, resolutions: { type: "array", items: { type: "object" } } },
		required: ["conflicts", "unavailable", "resolutions"] } as JsonSchema,
		fromJSON(json: unknown) {
			return json as { conflicts: import("./shared/lineage-resolution").ConflictEntry[];
				unavailable: Array<{ instanceId: number; reason: string }>;
				resolutions: import("./shared/lineage-resolution").PublicResolutionRecord[] };
		},
	};
}

export class ResolvePlatformLineageRequest {
	declare ["constructor"]: typeof ResolvePlatformLineageRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "control" as const;
	static dst = "controller" as const;
	static permission = PERMISSIONS.RECOVERY_RESOLVE;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: {
			instanceId: { type: "integer" }, platformIndex: { type: "integer", minimum: 1 }, platformUid: { type: "string", minLength: 1 },
			action: { enum: ["keep_this", "keep_other", "adopt", "stale_copy", "new_platform", "release"] },
			requestId: { type: "string", pattern: REQUEST_ID_PATTERN },
		},
		required: ["instanceId", "platformIndex", "platformUid", "action", "requestId"], additionalProperties: false,
	};
	instanceId: number;
	platformIndex: number;
	platformUid: string;
	action: import("./shared/lineage-resolution").ResolutionAction;
	requestId: string;
	constructor(json: { instanceId: number; platformIndex: number; platformUid: string; action: import("./shared/lineage-resolution").ResolutionAction; requestId: string }) {
		this.instanceId = json.instanceId; this.platformIndex = json.platformIndex; this.platformUid = json.platformUid;
		this.action = json.action; this.requestId = json.requestId;
	}
	static fromJSON(json: { instanceId: number; platformIndex: number; platformUid: string; action: import("./shared/lineage-resolution").ResolutionAction; requestId: string }) {
		return new ResolvePlatformLineageRequest(json);
	}
	toJSON() { return { instanceId: this.instanceId, platformIndex: this.platformIndex, platformUid: this.platformUid, action: this.action, requestId: this.requestId }; }
	static Response = {
		jsonSchema: { type: "object", properties: { success: { type: "boolean" }, error: { type: "string" }, requestId: { type: "string" },
			status: { type: "string" }, step: { type: "string" }, snapshotExportId: { type: ["string", "null"] }, passengers: { type: ["integer", "null"] } },
		required: ["success"] } as JsonSchema,
		fromJSON(json: unknown) {
			return json as SimpleResponse & { requestId?: string; status?: string; step?: string; snapshotExportId?: string | null; passengers?: number | null };
		},
	};
}

export class LineageCandidatesRequest {
	declare ["constructor"]: typeof LineageCandidatesRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "controller" as const;
	static dst = "instance" as const;
	static jsonSchema: JsonSchema = {
		type: "object", properties: { protectedSourceIndexes: { type: "array", items: { type: "integer" } } },
		required: ["protectedSourceIndexes"], additionalProperties: false,
	};
	protectedSourceIndexes: number[];
	constructor(json: { protectedSourceIndexes: number[] }) { this.protectedSourceIndexes = json.protectedSourceIndexes; }
	static fromJSON(json: { protectedSourceIndexes: number[] }) { return new LineageCandidatesRequest(json); }
	toJSON() { return { protectedSourceIndexes: this.protectedSourceIndexes }; }
	static Response = {
		jsonSchema: { type: "object", properties: { success: { type: "boolean" }, epoch: { type: "string" }, error: { type: "string" },
			platforms: { type: "array", items: { type: "object" } } }, required: ["success"] } as JsonSchema,
		fromJSON(json: unknown) {
			return json as { success: boolean; epoch?: string; error?: string; platforms?: import("./shared/lineage").ResolutionCandidate[] };
		},
	};
}

type ApplyStep = "prepare_delete" | "retarget" | "authorize" | "mint" | "release" | "restore";
type ApplyJson = { requestId: string; step: ApplyStep; platformIndex: number; platformUid: string; token: string;
	lineage?: string | null; generation?: number | null; exportId?: string | null; refreshIdentity?: boolean };

export class AbandonPlatformResolutionRequest {
	declare ["constructor"]: typeof AbandonPlatformResolutionRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "control" as const;
	static dst = "controller" as const;
	static permission = PERMISSIONS.RECOVERY_RESOLVE;
	static jsonSchema: JsonSchema = {
		type: "object", properties: { requestId: { type: "string", pattern: REQUEST_ID_PATTERN } }, required: ["requestId"], additionalProperties: false,
	};
	requestId: string;
	constructor(json: { requestId: string }) { this.requestId = json.requestId; }
	static fromJSON(json: { requestId: string }) { return new AbandonPlatformResolutionRequest(json); }
	toJSON() { return { requestId: this.requestId }; }
	static Response = ResolvePlatformLineageRequest.Response;
}

export type ReleaseTransferRollbackOutcome = "released" | "nothing_pending" | "refused";
export type ReleaseTransferRollbackResponse = SimpleResponse & {
	transferId?: string; outcome?: ReleaseTransferRollbackOutcome; status?: string; sourceState?: string; operator?: string | null;
	contradiction?: string | null; acknowledged?: boolean;
};

export class ReleaseTransferRollbackRequest {
	declare ["constructor"]: typeof ReleaseTransferRollbackRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "control" as const;
	static dst = "controller" as const;
	static permission = PERMISSIONS.RECOVERY_RESOLVE;
	static jsonSchema: JsonSchema = {
		type: "object", properties: { transferId: { type: "string", minLength: 1 }, acknowledgeContradiction: { type: "boolean" } },
		required: ["transferId"], additionalProperties: false,
	};
	transferId: string;
	acknowledgeContradiction: boolean;
	constructor(json: { transferId: string; acknowledgeContradiction?: boolean }) {
		this.transferId = json.transferId;
		this.acknowledgeContradiction = json.acknowledgeContradiction === true;
	}
	static fromJSON(json: { transferId: string; acknowledgeContradiction?: boolean }) { return new ReleaseTransferRollbackRequest(json); }
	toJSON() { return { transferId: this.transferId, acknowledgeContradiction: this.acknowledgeContradiction }; }
	static Response = {
		jsonSchema: { type: "object", properties: { success: { type: "boolean" }, error: { type: "string" }, transferId: { type: "string" },
			outcome: { enum: ["released", "nothing_pending", "refused"] }, status: { type: "string" }, sourceState: { type: "string" },
			operator: { type: ["string", "null"] }, contradiction: { type: ["string", "null"] }, acknowledged: { type: "boolean" } }, required: ["success"] } as JsonSchema,
		fromJSON(json: unknown) { return json as ReleaseTransferRollbackResponse; },
	};
}

export class ApplyLineageResolutionRequest {
	declare ["constructor"]: typeof ApplyLineageResolutionRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "controller" as const;
	static dst = "instance" as const;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: {
			requestId: { type: "string", pattern: REQUEST_ID_PATTERN },
			step: { enum: ["prepare_delete", "retarget", "authorize", "mint", "release", "restore"] },
			platformIndex: { type: "integer", minimum: 1 }, platformUid: { type: "string", minLength: 1 },
			token: { type: "string", minLength: 32, maxLength: 128 },
			lineage: { anyOf: [LINEAGE_SCHEMA, { type: "null" }] }, generation: { type: ["integer", "null"], minimum: 0 },
			exportId: { type: ["string", "null"] }, refreshIdentity: { type: "boolean" },
		},
		required: ["requestId", "step", "platformIndex", "platformUid", "token", "lineage", "generation", "exportId", "refreshIdentity"],
		additionalProperties: false,
	} as JsonSchema;
	requestId: string;
	step: ApplyStep;
	platformIndex: number;
	platformUid: string;
	token: string;
	lineage: string | null;
	generation: number | null;
	exportId: string | null;
	refreshIdentity: boolean;
	constructor(json: ApplyJson) {
		this.requestId = json.requestId; this.step = json.step; this.platformIndex = json.platformIndex; this.platformUid = json.platformUid;
		this.token = json.token; this.lineage = json.lineage ?? null; this.generation = json.generation ?? null;
		this.exportId = json.exportId ?? null; this.refreshIdentity = json.refreshIdentity === true;
	}
	static fromJSON(json: ApplyJson) {
		return new ApplyLineageResolutionRequest(json);
	}
	toJSON() {
		return { requestId: this.requestId, step: this.step, platformIndex: this.platformIndex, platformUid: this.platformUid, token: this.token,
			lineage: this.lineage, generation: this.generation, exportId: this.exportId, refreshIdentity: this.refreshIdentity };
	}
	static Response = {
		jsonSchema: { type: "object", properties: { success: { type: "boolean" }, error: { type: "string" }, jobId: { type: "string" },
			lineage: { type: "string" }, generation: { type: "integer" }, platformUid: { type: "string" }, committed: { type: "boolean" } },
			required: ["success"] } as JsonSchema,
		fromJSON(json: unknown) { return json as SimpleResponse & { jobId?: string; lineage?: string; generation?: number; platformUid?: string; committed?: boolean }; },
	};
}

export class GetStoredExportRequest {
	declare ["constructor"]: typeof GetStoredExportRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "control" as const;
	static dst = "controller" as const;
	static permission = PERMISSIONS.LIST_EXPORTS;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: { exportId: { type: "string" } },
		required: ["exportId"],
		additionalProperties: false,
	};

	exportId: string;

	constructor(json: { exportId: string }) {
		this.exportId = json.exportId;
	}

	static fromJSON(json: { exportId: string }) { return new GetStoredExportRequest(json); }
	toJSON() { return { exportId: this.exportId }; }

	static Response = {
		jsonSchema: {
			type: "object",
			properties: {
				success: { type: "boolean" },
				error: { type: "string" },
				exportId: { type: "string" },
				platformName: { type: "string" },
				instanceId: { type: "integer" },
				timestamp: { type: "number" },
				size: { type: "integer" },
				exportData: { type: "object" },
			},
			required: ["success"],
		} as JsonSchema,
		fromJSON(json: unknown) {
			return json as SimpleResponse & {
				exportId?: string; platformName?: string; instanceId?: number;
				timestamp?: number; size?: number; exportData?: Record<string, unknown>;
			};
		},
	};
}

export type ImportUploadedExportOptions = {
	targetInstanceId: number;
	exportData: Record<string, unknown>;
	restoreExportId?: string | null;
	restoreRequestId?: string | null;
	forceName?: string;
	platformName?: string | null;
	targetPlanet?: string | null;
};

export class ImportUploadedExportRequest {
	declare ["constructor"]: typeof ImportUploadedExportRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "control" as const;
	static dst = "controller" as const;
	static permission = PERMISSIONS.TRANSFER_EXPORTS;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: {
			targetInstanceId: { type: "integer" },
			exportData: { type: "object" },
			restoreExportId: { type: ["string", "null"], default: null },
			restoreRequestId: { type: ["string", "null"], default: null },
			forceName: { type: "string", default: "player" },
			platformName: { type: ["string", "null"], default: null },
			targetPlanet: { type: ["string", "null"], default: null },
		},
		required: ["targetInstanceId", "exportData"],
		additionalProperties: false,
	};

	targetInstanceId: number;
	exportData: Record<string, unknown>;
	restoreExportId: string | null;
	restoreRequestId: string | null;
	forceName: string;
	platformName: string | null;
	targetPlanet: string | null;

	constructor(json: ImportUploadedExportOptions) {
		this.targetInstanceId = json.targetInstanceId;
		this.exportData = json.exportData;
		this.restoreExportId = json.restoreExportId ?? null;
		this.restoreRequestId = json.restoreRequestId ?? null;
		this.forceName = json.forceName || "player";
		this.platformName = json.platformName ?? null;
		this.targetPlanet = json.targetPlanet ?? null;
	}

	static fromJSON(json: ImportUploadedExportOptions) {
		return new ImportUploadedExportRequest(json);
	}

	toJSON() {
		return { targetInstanceId: this.targetInstanceId, exportData: this.exportData, restoreExportId: this.restoreExportId, restoreRequestId: this.restoreRequestId, forceName: this.forceName, platformName: this.platformName, targetPlanet: this.targetPlanet };
	}

	static Response = {
		jsonSchema: {
			type: "object",
			properties: {
				success: { type: "boolean" },
				error: { type: "string" },
				platformName: { type: "string" },
				targetInstanceId: { type: "integer" },
			},
			required: ["success"],
		} as JsonSchema,
		fromJSON(json: unknown) { return json as SimpleResponse & { platformName?: string; targetInstanceId?: number }; },
	};
}

export class ExportPlatformForDownloadRequest {
	declare ["constructor"]: typeof ExportPlatformForDownloadRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "control" as const;
	static dst = "controller" as const;
	static permission = PERMISSIONS.TRANSFER_EXPORTS;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: {
			sourceInstanceId: { type: "integer" },
			sourcePlatformIndex: { type: "integer" },
			sourcePlatformUid: { type: "string", minLength: 1 },
			forceName: { type: "string", default: "player" },
		},
		required: ["sourceInstanceId", "sourcePlatformIndex"],
		additionalProperties: false,
	};

	sourceInstanceId: number;
	sourcePlatformIndex: number;
	sourcePlatformUid?: string;
	forceName: string;

	constructor(json: { sourcePlatformUid?: string; sourceInstanceId: number; sourcePlatformIndex: number; forceName?: string }) {
		this.sourceInstanceId = json.sourceInstanceId;
		this.sourcePlatformIndex = json.sourcePlatformIndex;
		this.sourcePlatformUid = json.sourcePlatformUid;
		this.forceName = json.forceName || "player";
	}

	static fromJSON(json: { sourcePlatformUid?: string; sourceInstanceId: number; sourcePlatformIndex: number; forceName?: string }) {
		return new ExportPlatformForDownloadRequest(json);
	}

	toJSON() {
		return { sourcePlatformUid: this.sourcePlatformUid, sourceInstanceId: this.sourceInstanceId, sourcePlatformIndex: this.sourcePlatformIndex, forceName: this.forceName };
	}

	static Response = {
		jsonSchema: {
			type: "object",
			properties: {
				success: { type: "boolean" },
				error: { type: "string" },
				exportId: { type: "string" },
				platformName: { type: "string" },
				instanceId: { type: "integer" },
				timestamp: { type: "number" },
				size: { type: "integer" },
				exportData: { type: "object" },
			},
			required: ["success"],
		} as JsonSchema,
		fromJSON(json: unknown) {
			return json as SimpleResponse & {
				exportId?: string; platformName?: string; instanceId?: number;
				timestamp?: number; size?: number; exportData?: Record<string, unknown>;
			};
		},
	};
}

export class GetPlatformTreeRequest {
	declare ["constructor"]: typeof GetPlatformTreeRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "control" as const;
	static dst = "controller" as const;
	static permission = PERMISSIONS.UI_VIEW;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: { forceName: { type: "string", default: "player" } },
		additionalProperties: false,
	};

	forceName: string;

	constructor(json: { forceName?: string } = {}) {
		this.forceName = json.forceName || "player";
	}

	static fromJSON(json: { forceName?: string }) { return new GetPlatformTreeRequest(json); }
	toJSON() { return { forceName: this.forceName }; }

	static Response = {
		jsonSchema: {
			type: "object",
			properties: {
				revision: { type: "integer" },
				generatedAt: { type: "number" },
				forceName: { type: "string" },
				hosts: { type: "array", items: { type: "object" } },
				unassignedInstances: { type: "array", items: { type: "object" } },
			},
			required: ["revision", "generatedAt", "forceName", "hosts", "unassignedInstances"],
		} as JsonSchema,
		fromJSON(json: unknown) {
			return json as { revision: number; generatedAt: number; forceName: string; hosts: unknown[]; unassignedInstances: unknown[] };
		},
	};
}

export class ListTransactionLogsRequest {
	declare ["constructor"]: typeof ListTransactionLogsRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "control" as const;
	static dst = "controller" as const;
	static permission = PERMISSIONS.VIEW_LOGS;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: { limit: { type: "integer", minimum: 1, maximum: 500, default: 50 } },
		additionalProperties: false,
	};

	limit: number;

	constructor(json: { limit?: number } = {}) {
		this.limit = json.limit || 50;
	}

	static fromJSON(json: { limit?: number }) { return new ListTransactionLogsRequest(json); }
	toJSON() { return { limit: this.limit }; }

	static Response = {
		jsonSchema: { type: "array", items: { type: "object" } } as JsonSchema,
		fromJSON(json: unknown) { return json as TransferSummaryModel[]; },
	};
}

export class SetSurfaceExportSubscriptionRequest {
	declare ["constructor"]: typeof SetSurfaceExportSubscriptionRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "control" as const;
	static dst = "controller" as const;
	static permission = PERMISSIONS.UI_VIEW;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: {
			tree: { type: "boolean", default: false },
			transfers: { type: "boolean", default: false },
			logs: { type: "boolean", default: false },
			transferId: { type: ["string", "null"], default: null },
		},
		additionalProperties: false,
	};

	tree: boolean;
	transfers: boolean;
	logs: boolean;
	transferId: string | null;

	constructor(json: { tree?: boolean; transfers?: boolean; logs?: boolean; transferId?: string | null } = {}) {
		this.tree = json.tree || false;
		this.transfers = json.transfers || false;
		this.logs = json.logs || false;
		this.transferId = json.transferId || null;
	}

	static fromJSON(json: { tree?: boolean; transfers?: boolean; logs?: boolean; transferId?: string | null }) {
		return new SetSurfaceExportSubscriptionRequest(json);
	}

	toJSON() {
		return { tree: this.tree, transfers: this.transfers, logs: this.logs, transferId: this.transferId };
	}
}

export class SurfaceExportTreeUpdateEvent {
	declare ["constructor"]: typeof SurfaceExportTreeUpdateEvent;
	static plugin = PLUGIN_NAME;
	static type = "event" as const;
	static src = "controller" as const;
	static dst = "control" as const;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: {
			revision: { type: "integer" },
			generatedAt: { type: "number" },
			forceName: { type: "string" },
			tree: { type: "object" },
		},
		required: ["revision", "generatedAt", "forceName", "tree"],
		additionalProperties: false,
	};

	revision: number;
	generatedAt: number;
	forceName: string;
	tree: Record<string, unknown>;

	constructor(json: { revision: number; generatedAt: number; forceName: string; tree: Record<string, unknown> }) {
		this.revision = json.revision;
		this.generatedAt = json.generatedAt;
		this.forceName = json.forceName;
		this.tree = json.tree;
	}

	static fromJSON(json: { revision: number; generatedAt: number; forceName: string; tree: Record<string, unknown> }) {
		return new SurfaceExportTreeUpdateEvent(json);
	}

	toJSON() {
		return { revision: this.revision, generatedAt: this.generatedAt, forceName: this.forceName, tree: this.tree };
	}
}

export class SurfaceExportTransferUpdateEvent {
	declare ["constructor"]: typeof SurfaceExportTransferUpdateEvent;
	static plugin = PLUGIN_NAME;
	static type = "event" as const;
	static src = "controller" as const;
	static dst = "control" as const;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: {
			revision: { type: "integer" },
			generatedAt: { type: "number" },
			transfer: { type: "object" },
		},
		required: ["revision", "generatedAt", "transfer"],
		additionalProperties: false,
	};

	revision: number;
	generatedAt: number;
	transfer: TransferSummaryModel;

	constructor(json: { revision: number; generatedAt: number; transfer: TransferSummaryModel }) {
		this.revision = json.revision;
		this.generatedAt = json.generatedAt;
		this.transfer = json.transfer;
	}

	static fromJSON(json: { revision: number; generatedAt: number; transfer: TransferSummaryModel }) {
		return new SurfaceExportTransferUpdateEvent(json);
	}

	toJSON() {
		return { revision: this.revision, generatedAt: this.generatedAt, transfer: this.transfer };
	}
}

export class SurfaceExportLogUpdateEvent {
	declare ["constructor"]: typeof SurfaceExportLogUpdateEvent;
	static plugin = PLUGIN_NAME;
	static type = "event" as const;
	static src = "controller" as const;
	static dst = "control" as const;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: {
			revision: { type: "integer" },
			generatedAt: { type: "number" },
			transferId: { type: "string" },
			event: { type: "object" },
			transferInfo: { type: ["object", "null"] },
			summary: { type: ["object", "null"] },
		},
		required: ["revision", "generatedAt", "transferId", "event", "transferInfo", "summary"],
		additionalProperties: false,
	};

	revision: number;
	generatedAt: number;
	transferId: string;
	event: TransactionLogEntryModel;
	transferInfo: Record<string, unknown> | null;
	summary: Record<string, unknown> | null;

	constructor(json: { revision: number; generatedAt: number; transferId: string; event: TransactionLogEntryModel; transferInfo: Record<string, unknown> | null; summary: Record<string, unknown> | null }) {
		this.revision = json.revision;
		this.generatedAt = json.generatedAt;
		this.transferId = json.transferId;
		this.event = json.event;
		this.transferInfo = json.transferInfo;
		this.summary = json.summary;
	}

	static fromJSON(json: { revision: number; generatedAt: number; transferId: string; event: TransactionLogEntryModel; transferInfo: Record<string, unknown> | null; summary: Record<string, unknown> | null }) {
		return new SurfaceExportLogUpdateEvent(json);
	}

	toJSON() {
		return {
			revision: this.revision, generatedAt: this.generatedAt, transferId: this.transferId,
			event: this.event, transferInfo: this.transferInfo, summary: this.summary,
		};
	}
}

export class PlatformExportEvent {
	declare ["constructor"]: typeof PlatformExportEvent;
	static plugin = PLUGIN_NAME;
	static type = "event" as const;
	static src = "instance" as const;
	static dst = "controller" as const;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: {
			exportId: { type: "string" },
			platformName: { type: "string" },
			platformIndex: { type: ["integer", "null"], default: null },
			instanceId: { type: "integer" },
			exportData: { type: "object" },
			timestamp: { type: "number" },
			exportMetrics: { type: ["object", "null"] },
		},
		required: ["exportId", "platformName", "instanceId", "exportData", "timestamp"],
		additionalProperties: false,
	};

	exportId: string;
	platformName: string;
	platformIndex: number | null;
	instanceId: number;
	exportData: Record<string, unknown>;
	timestamp: number;
	exportMetrics: ExportMetrics | null;

	constructor(json: { exportId: string; platformName: string; platformIndex?: number | null; instanceId: number; exportData: Record<string, unknown>; timestamp: number; exportMetrics?: ExportMetrics | null }) {
		this.exportId = json.exportId;
		this.platformName = json.platformName;
		this.platformIndex = Number.isInteger(json.platformIndex) ? (json.platformIndex as number) : null;
		this.instanceId = json.instanceId;
		this.exportData = json.exportData;
		this.timestamp = json.timestamp;
		this.exportMetrics = json.exportMetrics || null;
	}

	static fromJSON(json: { exportId: string; platformName: string; platformIndex?: number | null; instanceId: number; exportData: Record<string, unknown>; timestamp: number; exportMetrics?: ExportMetrics | null }) {
		return new PlatformExportEvent(json);
	}

	toJSON() {
		return {
			exportId: this.exportId, platformName: this.platformName, platformIndex: this.platformIndex,
			instanceId: this.instanceId,
			exportData: this.exportData, timestamp: this.timestamp, exportMetrics: this.exportMetrics,
		};
	}
}

export class ImportPlatformRequest {
	declare ["constructor"]: typeof ImportPlatformRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = ["controller", "instance"] as const;
	static dst = "instance" as const;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: {
			exportId: { type: "string" },
			exportData: { type: "object" },
			forceName: { type: "string", default: "player" },
			targetPlanet: { type: ["string", "null"], default: null },
		},
		required: ["exportId", "exportData"],
		additionalProperties: false,
	};

	exportId: string;
	exportData: Record<string, unknown>;
	forceName: string;
	targetPlanet: string | null;

	constructor(json: { exportId: string; exportData: Record<string, unknown>; forceName?: string; targetPlanet?: string | null }) {
		this.exportId = json.exportId;
		this.exportData = json.exportData;
		this.forceName = json.forceName || "player";
		this.targetPlanet = json.targetPlanet ?? null;
	}

	static fromJSON(json: { exportId: string; exportData: Record<string, unknown>; forceName?: string; targetPlanet?: string | null }) {
		return new ImportPlatformRequest(json);
	}

	toJSON() { return { exportId: this.exportId, exportData: this.exportData, forceName: this.forceName, targetPlanet: this.targetPlanet }; }

	static Response = {
		jsonSchema: { type: "object", properties: { success: { type: "boolean" }, error: { type: "string" }, jobId: {type: "string"}, epoch: {type: "string"}, attemptId: {type: "string"}, admissionUncertain: {type: "boolean"} }, required: ["success"] } as JsonSchema,
		fromJSON(json: unknown) { return json as ImportResult & { platformName?: string }; },
	};
}

export class ReadExportRequest {
	declare ["constructor"]: typeof ReadExportRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "controller" as const;
	static dst = "instance" as const;
	static jsonSchema: JsonSchema = {
		type: "object", properties: {exportId: {type: "string", minLength: 1}, epoch: {type: "string", minLength: 1}},
		required: ["exportId", "epoch"], additionalProperties: false,
	};
	constructor(readonly exportId: string, readonly epoch: string) {}
	static fromJSON(json: {exportId: string; epoch: string}) { return new ReadExportRequest(json.exportId, json.epoch); }
	toJSON() { return {exportId: this.exportId, epoch: this.epoch}; }
	static Response = {
		jsonSchema: {type: "object", properties: {success: {type: "boolean"}, error: {type: "string"},
			exportId: {type: "string"}, epoch: {type: "string"}, exportData: {type: "object"}}, required: ["success"]} as JsonSchema,
		fromJSON(json: unknown) { return json as SimpleResponse & {exportId?: string; epoch?: string; exportData?: ExportData}; },
	};
}

export class JobsStatusRequest {
	declare ["constructor"]: typeof JobsStatusRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "controller" as const;
	static dst = "instance" as const;
	static jsonSchema: JsonSchema = {
		type: "object", properties: {jobs: {type: "array", maxItems: 100, items: {
			type: "object", properties: {jobId: {type: "string"}, operationId: {type: "string"}}, additionalProperties: false,
		}}}, required: ["jobs"], additionalProperties: false,
	};
	constructor(readonly jobs: import("./shared/job-status").JobReference[]) {}
	static fromJSON(json: {jobs: import("./shared/job-status").JobReference[]}) { return new JobsStatusRequest(json.jobs); }
	toJSON() { return {jobs: this.jobs}; }
	static Response = {
		jsonSchema: {type: "object", properties: {version: {type: "number"}, epoch: {type: "string"}, observedTick: {type: "number"}, jobs: {type: "array", items: {type: "object"}}}, required: ["version", "epoch", "jobs"]} as JsonSchema,
		fromJSON(json: unknown) { return json as import("./shared/job-status").JobStatusBatch; },
	};
}

export class ListExportsRequest {
	declare ["constructor"]: typeof ListExportsRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "control" as const;
	static dst = "controller" as const;
	static permission = PERMISSIONS.LIST_EXPORTS;
	static jsonSchema: JsonSchema = { type: "object", properties: {}, additionalProperties: false };

	constructor() { }
	static fromJSON() { return new ListExportsRequest(); }
	toJSON() { return {}; }

	static Response = {
		jsonSchema: { type: "array", items: { type: "object" } } as JsonSchema,
		fromJSON(json: unknown) { return json as StoredExportSummaryModel[]; },
	};
}

export class TransferPlatformRequest {
	declare ["constructor"]: typeof TransferPlatformRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = ["control", "instance"] as const;
	static dst = "controller" as const;
	static permission = PERMISSIONS.TRANSFER_EXPORTS;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: {
			exportId: { type: "string" },
			targetInstanceId: { type: "integer" },
			sourceInstanceId: { type: ["integer", "null"], default: null },
			sourceExportId: { type: ["string", "null"], default: null },
		},
		required: ["exportId", "targetInstanceId"],
		additionalProperties: false,
	};

	exportId: string;
	targetInstanceId: number;
	sourceInstanceId: number | null;
	sourceExportId: string | null;

	constructor(json: { exportId: string; targetInstanceId: number; sourceInstanceId?: number | null; sourceExportId?: string | null }) {
		this.exportId = json.exportId;
		this.targetInstanceId = json.targetInstanceId;
		this.sourceInstanceId = Number.isInteger(json.sourceInstanceId) ? (json.sourceInstanceId as number) : null;
		this.sourceExportId = json.sourceExportId ?? null;
	}

	static fromJSON(json: { exportId: string; targetInstanceId: number; sourceInstanceId?: number | null; sourceExportId?: string | null }) { return new TransferPlatformRequest(json); }
	toJSON() { return { exportId: this.exportId, targetInstanceId: this.targetInstanceId, sourceInstanceId: this.sourceInstanceId, sourceExportId: this.sourceExportId }; }

	static Response = {
		jsonSchema: { type: "object", properties: { success: { type: "boolean" }, error: { type: "string" }, transferId: { type: "string" }, message: { type: "string" }, safeToUnlockSource: { type: "boolean" } }, required: ["success"] } as JsonSchema,
		fromJSON(json: unknown) { return json as SimpleResponse & { transferId?: string; message?: string; safeToUnlockSource?: boolean }; },
	};
}

export class StartPlatformTransferRequest {
	declare ["constructor"]: typeof StartPlatformTransferRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "control" as const;
	static dst = "controller" as const;
	static permission = PERMISSIONS.TRANSFER_EXPORTS;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: {
			platformName: { type: "string", maxLength: 500 },
			sourceInstanceId: { type: "integer" },
			sourcePlatformIndex: { type: "integer" },
			sourcePlatformUid: { type: "string", minLength: 1 },
			targetInstanceId: { type: "integer" },
			forceName: { type: "string", default: "player" },
			targetPlanet: { type: ["string", "null"], default: null },
		},
		required: ["sourceInstanceId", "sourcePlatformIndex", "targetInstanceId"],
		additionalProperties: false,
	};

	platformName?: string;
	sourceInstanceId: number;
	sourcePlatformIndex: number;
	sourcePlatformUid?: string;
	targetInstanceId: number;
	forceName: string;
	targetPlanet: string | null;

	constructor(json: { sourcePlatformUid?: string; platformName?: string; sourceInstanceId: number; sourcePlatformIndex: number; targetInstanceId: number; forceName?: string; targetPlanet?: string | null }) {
		this.platformName = json.platformName;
		this.sourceInstanceId = json.sourceInstanceId;
		this.sourcePlatformIndex = json.sourcePlatformIndex;
		this.sourcePlatformUid = json.sourcePlatformUid;
		this.targetInstanceId = json.targetInstanceId;
		this.forceName = json.forceName || "player";
		this.targetPlanet = json.targetPlanet ?? null;
	}

	static fromJSON(json: { sourcePlatformUid?: string; platformName?: string; sourceInstanceId: number; sourcePlatformIndex: number; targetInstanceId: number; forceName?: string; targetPlanet?: string | null }) {
		return new StartPlatformTransferRequest(json);
	}

	toJSON() {
		return { sourcePlatformUid: this.sourcePlatformUid, platformName: this.platformName, sourceInstanceId: this.sourceInstanceId, sourcePlatformIndex: this.sourcePlatformIndex, targetInstanceId: this.targetInstanceId, forceName: this.forceName, targetPlanet: this.targetPlanet };
	}

	static Response = {
		jsonSchema: { type: "object", properties: { success: { type: "boolean" }, error: { type: "string" }, transferId: { type: "string" }, exportId: { type: "string" }, message: { type: "string" }, safeToUnlockSource: { type: "boolean" } }, required: ["success"] } as JsonSchema,
		fromJSON(json: unknown) { return json as SimpleResponse & { transferId?: string; exportId?: string; message?: string; safeToUnlockSource?: boolean }; },
	};
}

export class InstanceListPlatformsRequest {
	declare ["constructor"]: typeof InstanceListPlatformsRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "controller" as const;
	static dst = "instance" as const;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: { forceName: { type: "string", default: "player" } },
		additionalProperties: false,
	};

	forceName: string;

	constructor(json: { forceName?: string } = {}) {
		this.forceName = json.forceName || "player";
	}

	static fromJSON(json: { forceName?: string }) { return new InstanceListPlatformsRequest(json); }
	toJSON() { return { forceName: this.forceName }; }

	static Response = {
		jsonSchema: { type: "object", properties: { instanceId: { type: "integer" }, instanceName: { type: "string" }, forceName: { type: "string" }, platforms: { type: "array" }, debugMode: { type: "boolean" }, autoPause: { type: ["boolean", "null"] } }, required: ["instanceId", "instanceName", "forceName", "platforms"] } as JsonSchema,
		fromJSON(json: unknown) { return json as { instanceId: number; instanceName: string; forceName: string; platforms: PlatformModel[]; debugMode?: boolean; autoPause?: boolean | null; recovery?: import("./shared/recovery").InstanceRecoveryStatus }; },
	};
}

const RESOLVED_TARGET_SCHEMA: JsonSchema = {
	type: "object",
	properties: {
		instanceId: { type: "integer" },
		instanceName: { type: "string" },
		targetGateway: { type: "string" },
		online: { type: "boolean" },
		address: { type: "string" },
	},
	required: ["instanceId", "instanceName", "targetGateway", "online"],
	additionalProperties: false,
};
const RESOLVED_GATEWAYS_SCHEMA: JsonSchema = {
	type: "array",
	items: {
		type: "object",
		properties: {
			gatewayName: { type: "string" },
			targets: { type: "array", items: RESOLVED_TARGET_SCHEMA },
		},
		required: ["gatewayName", "targets"],
		additionalProperties: false,
	},
};
const PASSENGER_CARRY_SCHEMA: JsonSchema = {
	type: "object",
	properties: { armor: { type: "boolean" }, inventory: { type: "boolean" } },
	required: ["armor", "inventory"],
	additionalProperties: false,
};
const PASSENGER_MANIFEST_SCHEMA: JsonSchema = {
	type: "array",
	items: {
		type: "object",
		properties: {
			name: { type: "string" },
			items: { type: "array", items: { type: "object" } },
		},
		required: ["name"],
	},
};

export class GetGatewaysRequest {
	declare ["constructor"]: typeof GetGatewaysRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "control" as const;
	static dst = "controller" as const;
	static permission = PERMISSIONS.UI_VIEW;
	static jsonSchema: JsonSchema = { type: "object", properties: {}, additionalProperties: false };

	constructor(_json: Record<string, unknown> = {}) {}

	static fromJSON(_json: unknown) { return new GetGatewaysRequest(); }
	toJSON() { return {}; }

	static Response = {
		jsonSchema: {
			type: "object",
			properties: {
				portals: {
					type: "array",
					items: {
						type: "object",
						properties: {
							slot: { type: "integer" },
							colour: { type: "string" },
							gatewayName: { type: "string" },
							instanceId: { type: "integer" },
							instanceName: { type: "string" },
						},
						required: ["slot", "colour", "gatewayName", "instanceId", "instanceName"],
						additionalProperties: false,
					},
				},
				pluginOff: {
					type: "array",
					items: {
						type: "object",
						properties: {
							slot: { type: "integer" },
							colour: { type: "string" },
							gatewayName: { type: "string" },
							instanceId: { type: "integer" },
							instanceName: { type: "string" },
						},
						required: ["slot", "colour", "gatewayName", "instanceId", "instanceName"],
						additionalProperties: false,
					},
				},
				unassigned: {
					type: "array",
					items: {
						type: "object",
						properties: { instanceId: { type: "integer" }, instanceName: { type: "string" } },
						required: ["instanceId", "instanceName"],
						additionalProperties: false,
					},
				},
				retired: {
					type: "array",
					items: {
						type: "object",
						properties: {
							slot: { type: "integer" },
							colour: { type: "string" },
							gatewayName: { type: "string" },
							formerInstanceId: { type: "integer" },
							formerInstanceName: { type: "string" },
						},
						required: ["slot", "colour", "gatewayName", "formerInstanceId", "formerInstanceName"],
						additionalProperties: false,
					},
				},
				error: { type: "string" },
			},
			required: ["portals", "unassigned", "retired"],
		} as JsonSchema,
		fromJSON(json: unknown) {
			return json as PortalListingResponse;
		},
	};
}

export class SetPortalRequest {
	declare ["constructor"]: typeof SetPortalRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "control" as const;
	static dst = "controller" as const;
	static permission = PERMISSIONS.TRANSFER_EXPORTS;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: { action: { enum: ["assign", "release"] }, portal: { type: "string" }, instance: { type: "string" } },
		required: ["action", "portal"],
		additionalProperties: false,
	};

	action: "assign" | "release";
	portal: string;
	instance?: string;

	constructor(json: { action: "assign" | "release"; portal: string; instance?: string }) {
		this.action = json.action;
		this.portal = json.portal;
		this.instance = json.instance;
	}

	static fromJSON(json: { action: "assign" | "release"; portal: string; instance?: string }) { return new SetPortalRequest(json); }
	toJSON() { return { action: this.action, portal: this.portal, instance: this.instance }; }

	static Response = GetGatewaysRequest.Response;
}

export interface GatewayConfigPayload {
	gateways: ResolvedGateway[];
	activeGatewayNames?: string[];
	ownGatewayName?: string;
	passengerCarry?: PassengerCarry;
	discordInvite?: string;
}

export class GetGatewayConfigRequest {
	declare ["constructor"]: typeof GetGatewayConfigRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "instance" as const;
	static dst = "controller" as const;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: { instanceId: { type: "integer" } },
		required: ["instanceId"],
		additionalProperties: false,
	};

	instanceId: number;

	constructor(json: { instanceId: number }) {
		this.instanceId = json.instanceId;
	}

	static fromJSON(json: { instanceId: number }) { return new GetGatewayConfigRequest(json); }
	toJSON() { return { instanceId: this.instanceId }; }

	static Response = {
		jsonSchema: { type: "object", properties: { gateways: RESOLVED_GATEWAYS_SCHEMA, activeGatewayNames: { type: "array", items: { type: "string" } }, ownGatewayName: { type: "string" }, passengerCarry: PASSENGER_CARRY_SCHEMA, discordInvite: { type: "string" } }, required: ["gateways"] } as JsonSchema,
		fromJSON(json: unknown) {
			return json as GatewayConfigPayload;
		},
	};
}

export interface RosterInstance {
	instanceId: number;
	name: string;
	address: string;
	online: boolean;
	self: boolean;
}

const ROSTER_INSTANCES_SCHEMA: JsonSchema = {
	type: "array",
	items: {
		type: "object",
		properties: {
			instanceId: { type: "integer" },
			name: { type: "string" },
			address: { type: "string" },
			online: { type: "boolean" },
			self: { type: "boolean" },
		},
		required: ["instanceId", "name", "address", "online", "self"],
		additionalProperties: false,
	},
};

export class GetInstanceRosterRequest {
	declare ["constructor"]: typeof GetInstanceRosterRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "instance" as const;
	static dst = "controller" as const;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: { instanceId: { type: "integer" } },
		required: ["instanceId"],
		additionalProperties: false,
	};

	instanceId: number;

	constructor(json: { instanceId: number }) {
		this.instanceId = json.instanceId;
	}

	static fromJSON(json: { instanceId: number }) { return new GetInstanceRosterRequest(json); }
	toJSON() { return { instanceId: this.instanceId }; }

	static Response = {
		jsonSchema: {
			type: "object",
			properties: { instances: ROSTER_INSTANCES_SCHEMA },
			required: ["instances"],
		} as JsonSchema,
		fromJSON(json: unknown) {
			return json as { instances: RosterInstance[] };
		},
	};
}

export class AnnouncePlayerTravelRequest {
	declare ["constructor"]: typeof AnnouncePlayerTravelRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "controller" as const;
	static dst = "instance" as const;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: { playerName: { type: "string" }, sourceName: { type: "string" }, targetName: { type: "string" } },
		required: ["playerName", "sourceName", "targetName"], additionalProperties: false,
	};
	constructor(public playerName: string, public sourceName: string, public targetName: string) {}
	toJSON() { return { playerName: this.playerName, sourceName: this.sourceName, targetName: this.targetName }; }
	static fromJSON(json: { playerName: string; sourceName: string; targetName: string }) {
		return new this(json.playerName, json.sourceName, json.targetName);
	}
	static Response = {
		jsonSchema: { type: "object", properties: { success: { type: "boolean" }, error: { type: "string" } }, required: ["success"] } as JsonSchema,
		fromJSON(json: unknown) { return json as SimpleResponse; },
	};
}

export interface RouteAlert {
	key: string;
	platformName: string;
	forceName: string;
	icon: string;
	active: boolean;
	reason?: unknown;
}

const ROUTE_ALERT_SCHEMA: JsonSchema = {
	type: "object",
	properties: {
		key: { type: "string" }, platformName: { type: "string" }, forceName: { type: "string" },
		icon: { type: "string" }, active: { type: "boolean" }, reason: {},
	},
	required: ["key", "platformName", "forceName", "icon", "active"],
	additionalProperties: false,
};

export class RouteAlertEvent {
	declare ["constructor"]: typeof RouteAlertEvent;
	static plugin = PLUGIN_NAME;
	static type = "event" as const;
	static src = "instance" as const;
	static dst = "controller" as const;
	static jsonSchema: JsonSchema = { type: "object", properties: { alert: ROUTE_ALERT_SCHEMA }, required: ["alert"], additionalProperties: false };
	constructor(public alert: RouteAlert) {}
	toJSON() { return { alert: this.alert }; }
	static fromJSON(json: { alert: RouteAlert }) { return new this(json.alert); }
}

export class RelayRouteAlertRequest {
	declare ["constructor"]: typeof RelayRouteAlertRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "controller" as const;
	static dst = "instance" as const;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: { alert: ROUTE_ALERT_SCHEMA, sourceInstanceId: { type: "integer" }, sourceName: { type: "string" } },
		required: ["alert", "sourceInstanceId", "sourceName"],
		additionalProperties: false,
	};
	constructor(public alert: RouteAlert, public sourceInstanceId: number, public sourceName: string) {}
	toJSON() { return { alert: this.alert, sourceInstanceId: this.sourceInstanceId, sourceName: this.sourceName }; }
	static fromJSON(json: { alert: RouteAlert; sourceInstanceId: number; sourceName: string }) {
		return new this(json.alert, json.sourceInstanceId, json.sourceName);
	}
	static Response = {
		jsonSchema: { type: "object", properties: { success: { type: "boolean" }, error: { type: "string" } }, required: ["success"] } as JsonSchema,
		fromJSON(json: unknown) { return json as SimpleResponse; },
	};
}

export class PushGatewayConfigRequest {
	declare ["constructor"]: typeof PushGatewayConfigRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "controller" as const;
	static dst = "instance" as const;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: { gateways: RESOLVED_GATEWAYS_SCHEMA, activeGatewayNames: { type: "array", items: { type: "string" } }, ownGatewayName: { type: "string" }, passengerCarry: PASSENGER_CARRY_SCHEMA, discordInvite: { type: "string" } },
		required: ["gateways"],
		additionalProperties: false,
	};

	gateways: ResolvedGateway[];
	activeGatewayNames?: string[];
	ownGatewayName?: string;
	passengerCarry?: PassengerCarry;
	discordInvite?: string;

	constructor(json: GatewayConfigPayload) {
		this.gateways = json.gateways;
		this.activeGatewayNames = json.activeGatewayNames;
		this.ownGatewayName = json.ownGatewayName;
		this.passengerCarry = json.passengerCarry;
		this.discordInvite = json.discordInvite;
	}

	static fromJSON(json: GatewayConfigPayload) {
		return new PushGatewayConfigRequest(json);
	}
	toJSON() { return { gateways: this.gateways, activeGatewayNames: this.activeGatewayNames, ownGatewayName: this.ownGatewayName, passengerCarry: this.passengerCarry, discordInvite: this.discordInvite }; }

	static Response = {
		jsonSchema: { type: "object", properties: { success: { type: "boolean" }, error: { type: "string" } }, required: ["success"] } as JsonSchema,
		fromJSON(json: unknown) { return json as SimpleResponse; },
	};
}

export class ImportPlatformFromFileRequest {
	declare ["constructor"]: typeof ImportPlatformFromFileRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = ["controller", "instance"] as const;
	static dst = "instance" as const;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: {
			filename: { type: "string" },
			platformName: { type: ["string", "null"], default: null },
			forceName: { type: "string", default: "player" },
		},
		required: ["filename"],
		additionalProperties: false,
	};

	filename: string;
	platformName: string | null;
	forceName: string;

	constructor(json: { filename: string; platformName?: string | null; forceName?: string }) {
		this.filename = json.filename;
		this.platformName = json.platformName ?? null;
		this.forceName = json.forceName || "player";
	}

	static fromJSON(json: { filename: string; platformName?: string | null; forceName?: string }) {
		return new ImportPlatformFromFileRequest(json);
	}

	toJSON() { return { filename: this.filename, platformName: this.platformName, forceName: this.forceName }; }

	static Response = ImportPlatformRequest.Response;
}

export class TransferValidationEvent {
	declare ["constructor"]: typeof TransferValidationEvent;
	static plugin = PLUGIN_NAME;
	static type = "event" as const;
	static src = "instance" as const;
	static dst = "controller" as const;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: {
			transferId: { type: "string" },
			platformName: { type: "string" },
			sourceInstanceId: { type: "integer" },
			success: { type: "boolean" },
			validation: { type: "object" },
			metrics: { type: "object" },
		},
		required: ["transferId", "platformName", "sourceInstanceId", "success"],
		additionalProperties: false,
	};

	transferId: string;
	platformName: string;
	sourceInstanceId: number;
	success: boolean;
	validation?: ValidationResult;
	metrics?: Record<string, unknown>;

	constructor(json: { transferId: string; platformName: string; sourceInstanceId: number; success: boolean; validation?: ValidationResult; metrics?: Record<string, unknown> }) {
		this.transferId = json.transferId;
		this.platformName = json.platformName;
		this.sourceInstanceId = json.sourceInstanceId;
		this.success = json.success;
		this.validation = json.validation;
		this.metrics = json.metrics;
	}

	static fromJSON(json: { transferId: string; platformName: string; sourceInstanceId: number; success: boolean; validation?: ValidationResult; metrics?: Record<string, unknown> }) {
		return new TransferValidationEvent(json);
	}

	toJSON() {
		return { transferId: this.transferId, platformName: this.platformName, sourceInstanceId: this.sourceInstanceId, success: this.success, validation: this.validation, metrics: this.metrics };
	}
}

export class ImportOperationCompleteEvent {
	declare ["constructor"]: typeof ImportOperationCompleteEvent;
	static plugin = PLUGIN_NAME;
	static type = "event" as const;
	static src = "instance" as const;
	static dst = "controller" as const;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: {
			operationId: { type: "string" },
			platformName: { type: "string" },
			instanceId: { type: "integer" },
			success: { type: "boolean" },
			error: { type: ["string", "null"] },
			failedStage: { type: ["string", "null"] },
			cleanupFailed: { type: "boolean" },
			destinationPreserved: { type: "boolean" },
			durationTicks: { type: ["integer", "null"] },
			entityCount: { type: ["integer", "null"] },
			metrics: { type: ["object", "null"] },
			validation: { type: ["object", "null"] },
		},
		required: ["operationId", "platformName", "instanceId", "success"],
		additionalProperties: false,
	};

	operationId: string;
	platformName: string;
	instanceId: number;
	success: boolean;
	error: string | null;
	failedStage: string | null;
	cleanupFailed: boolean;
	destinationPreserved: boolean;
	durationTicks: number | null;
	entityCount: number | null;
	metrics: Record<string, unknown> | null;
	validation: ValidationResult | null;

	constructor(json: { operationId: string; platformName: string; instanceId: number; success: boolean; error?: string | null; failedStage?: string | null; cleanupFailed?: boolean; destinationPreserved?: boolean; durationTicks?: number | null; entityCount?: number | null; metrics?: Record<string, unknown> | null; validation?: ValidationResult | null }) {
		this.operationId = json.operationId;
		this.platformName = json.platformName;
		this.instanceId = json.instanceId;
		this.success = json.success;
		this.error = json.error ?? null;
		this.failedStage = json.failedStage ?? null;
		this.cleanupFailed = json.cleanupFailed === true;
		this.destinationPreserved = json.destinationPreserved === true;
		this.durationTicks = json.durationTicks ?? null;
		this.entityCount = json.entityCount ?? null;
		this.metrics = json.metrics ?? null;
		this.validation = json.validation ?? null;
	}

	static fromJSON(json: { operationId: string; platformName: string; instanceId: number; success: boolean; error?: string | null; failedStage?: string | null; cleanupFailed?: boolean; destinationPreserved?: boolean; durationTicks?: number | null; entityCount?: number | null; metrics?: Record<string, unknown> | null; validation?: ValidationResult | null }) {
		return new ImportOperationCompleteEvent(json);
	}

	toJSON() {
		return { operationId: this.operationId, platformName: this.platformName, instanceId: this.instanceId, success: this.success, error: this.error, failedStage: this.failedStage, cleanupFailed: this.cleanupFailed, destinationPreserved: this.destinationPreserved, durationTicks: this.durationTicks, entityCount: this.entityCount, metrics: this.metrics, validation: this.validation };
	}
}

export class DestinationTransferGateRequest {
	declare ["constructor"]: typeof DestinationTransferGateRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "controller" as const;
	static dst = "instance" as const;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: { transferId: { type: "string" }, action: { enum: ["verify", "go_live", "discard"] }, passengers: PASSENGER_MANIFEST_SCHEMA },
		required: ["transferId", "action"], additionalProperties: false,
	};
	transferId: string;
	action: "verify" | "go_live" | "discard";
	passengers?: PassengerManifestEntry[];
	constructor(json: { transferId: string; action: "verify" | "go_live" | "discard"; passengers?: PassengerManifestEntry[] }) {
		this.transferId = json.transferId;
		this.action = json.action;
		this.passengers = json.passengers;
	}
	static fromJSON(json: { transferId: string; action: "verify" | "go_live" | "discard"; passengers?: PassengerManifestEntry[] }) { return new DestinationTransferGateRequest(json); }
	toJSON() { return { transferId: this.transferId, action: this.action, passengers: this.passengers }; }
	static Response = {
		jsonSchema: { type: "object", properties: { success: { type: "boolean" }, error: { type: "string" },
			lineage: LINEAGE_SCHEMA, generation: { type: "integer", minimum: 1 }, localCopy: { type: "boolean" } }, required: ["success"] } as JsonSchema,
		fromJSON(json: unknown) { return json as SimpleResponse & { lineage?: string; generation?: number; localCopy?: boolean }; },
	};
}

export class DeleteSourcePlatformRequest {
	declare ["constructor"]: typeof DeleteSourcePlatformRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "controller" as const;
	static dst = "instance" as const;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: {
			platformIndex: { type: "integer" },
			platformName: { type: "string" },
			forceName: { type: "string", default: "player" },
			exportId: { type: ["string", "null"], default: null },
		},
		required: ["platformIndex", "platformName"],
		additionalProperties: false,
	};

	platformIndex: number;
	platformName: string;
	forceName: string;
	exportId: string | null;

	constructor(json: { platformIndex: number; platformName: string; forceName?: string; exportId?: string | null }) {
		this.platformIndex = json.platformIndex;
		this.platformName = json.platformName;
		this.forceName = json.forceName || "player";
		this.exportId = json.exportId ?? null;
	}

	static fromJSON(json: { platformIndex: number; platformName: string; forceName?: string; exportId?: string | null }) { return new DeleteSourcePlatformRequest(json); }
	toJSON() { return { platformIndex: this.platformIndex, platformName: this.platformName, forceName: this.forceName, exportId: this.exportId }; }

	static Response = {
		jsonSchema: { type: "object", properties: { success: { type: "boolean" }, error: { type: "string" }, passengers: PASSENGER_MANIFEST_SCHEMA }, required: ["success"] } as JsonSchema,
		fromJSON(json: unknown) { return json as SimpleResponse & { passengers?: PassengerManifestEntry[] }; },
	};
}


export class UnlockSourcePlatformRequest {
	declare ["constructor"]: typeof UnlockSourcePlatformRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "controller" as const;
	static dst = "instance" as const;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: {
			platformIndex: { type: "integer" },
			operationId: { type: "string" },
			platformName: { type: ["string", "null"] },
			forceName: { type: "string", default: "player" },
		},
		required: ["platformIndex"],
		additionalProperties: false,
	};

	operationId?: string;
	platformIndex: number;
	platformName: string | null;
	forceName: string;

	constructor(json: { operationId?: string; platformIndex: number; platformName?: string | null; forceName?: string }) {
		this.operationId = json.operationId;
		this.platformIndex = json.platformIndex;
		this.platformName = json.platformName ?? null;
		this.forceName = json.forceName || "player";
	}

	static fromJSON(json: { operationId?: string; platformIndex: number; platformName?: string | null; forceName?: string }) { return new UnlockSourcePlatformRequest(json); }
	toJSON() { return { operationId: this.operationId, platformIndex: this.platformIndex, platformName: this.platformName, forceName: this.forceName }; }

	static Response = {
		jsonSchema: { type: "object", properties: { success: { type: "boolean" }, error: { type: "string" } }, required: ["success"] } as JsonSchema,
		fromJSON(json: unknown) { return json as SimpleResponse; },
	};
}

export class GetSourceTransferLockStateRequest {
	declare ["constructor"]: typeof GetSourceTransferLockStateRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "controller" as const;
	static dst = "instance" as const;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: {
			transferId: { type: "string" },
			platformIndex: { type: "integer" },
			platformName: { type: "string" },
			forceName: { type: "string", default: "player" },
		},
		required: ["transferId", "platformIndex", "platformName"],
		additionalProperties: false,
	};

	transferId: string;
	platformIndex: number;
	platformName: string;
	forceName: string;

	constructor(json: { transferId: string; platformIndex: number; platformName: string; forceName?: string }) {
		this.transferId = json.transferId;
		this.platformIndex = json.platformIndex;
		this.platformName = json.platformName;
		this.forceName = json.forceName || "player";
	}

	static fromJSON(json: { transferId: string; platformIndex: number; platformName: string; forceName?: string }) { return new GetSourceTransferLockStateRequest(json); }
	toJSON() { return { transferId: this.transferId, platformIndex: this.platformIndex, platformName: this.platformName, forceName: this.forceName }; }

	static Response = {
		jsonSchema: {
			type: "object",
			properties: {
				state: { enum: SOURCE_TRANSFER_LOCK_STATES },
				transferId: { type: ["string", "null"] },
				error: { type: ["string", "null"] },
			},
			required: ["state"],
			additionalProperties: false,
		} as JsonSchema,
		fromJSON(json: unknown) { return json as SourceTransferLockStateResponse; },
	};
}
export class TransferStatusUpdate {
	declare ["constructor"]: typeof TransferStatusUpdate;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "controller" as const;
	static dst = "instance" as const;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: {
			transferId: { type: "string" },
			platformName: { type: "string" },
			message: { type: "string" },
			color: { type: ["string", "null"] },
		},
		required: ["transferId", "platformName", "message"],
		additionalProperties: false,
	};

	transferId: string;
	platformName: string;
	message: string;
	color: string | null;

	constructor(json: { transferId: string; platformName: string; message: string; color?: string | null }) {
		this.transferId = json.transferId;
		this.platformName = json.platformName;
		this.message = json.message;
		this.color = json.color || null;
	}

	static fromJSON(json: { transferId: string; platformName: string; message: string; color?: string | null }) {
		return new TransferStatusUpdate(json);
	}

	toJSON() { return { transferId: this.transferId, platformName: this.platformName, message: this.message, color: this.color }; }

	static Response = {
		jsonSchema: { type: "object", properties: { success: { type: "boolean" }, error: { type: "string" } }, required: ["success"] } as JsonSchema,
		fromJSON(json: unknown) { return json as SimpleResponse; },
	};
}

export class ReadEntityEvidenceRequest {
	declare ["constructor"]: typeof ReadEntityEvidenceRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = "controller" as const;
	static dst = "instance" as const;
	static jsonSchema: JsonSchema = { type: "object", properties: {
		transferId: { type: "string" }, file: { type: "string", maxLength: 512 }, tick: { type: "integer", minimum: 0 },
	}, required: ["transferId", "file", "tick"], additionalProperties: false };
	constructor(public transferId: string, public file: string, public tick: number) {}
	static fromJSON(json: { transferId: string; file: string; tick: number }) { return new ReadEntityEvidenceRequest(json.transferId, json.file, json.tick); }
	toJSON() { return { transferId: this.transferId, file: this.file, tick: this.tick }; }
	static Response = {
		jsonSchema: { type: "object", properties: { status: { enum: ["available", "unavailable"] }, file: { type: "string" }, rows: { type: "array" }, totalRows: { type: "integer" }, truncated: { type: "boolean" }, reason: { type: "string" } }, required: ["status", "file", "rows", "totalRows", "truncated"] } as JsonSchema,
		fromJSON(json: unknown) { return json as import("./shared/entity-evidence").EntityEvidence; },
	};
}

export class GetTransactionLogRequest {
	declare ["constructor"]: typeof GetTransactionLogRequest;
	static plugin = PLUGIN_NAME;
	static type = "request" as const;
	static src = ["controller", "instance", "control"] as const;
	static dst = "controller" as const;
	static permission = PERMISSIONS.VIEW_LOGS;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: { transferId: { type: "string" } },
		required: ["transferId"],
		additionalProperties: false,
	};

	transferId: string;

	constructor(json: { transferId: string }) {
		this.transferId = json.transferId;
	}

	static fromJSON(json: { transferId: string }) { return new GetTransactionLogRequest(json); }
	toJSON() { return { transferId: this.transferId }; }

	static Response = {
		jsonSchema: { type: "object", properties: { success: { type: "boolean" }, transferId: { type: "string" }, events: { type: "array" }, detailRetained: { type: "boolean" }, transferInfo: { type: ["object", "null"] }, summary: { type: ["object", "null"] }, error: { type: "string" } }, required: ["success"] } as JsonSchema,
		fromJSON(json: unknown) {
			return json as SimpleResponse & {
				transferId?: string;
				events?: TransactionLogEntryModel[];
				detailRetained?: boolean;
				transferInfo?: Record<string, unknown> | null;
				summary?: Record<string, unknown> | null;
			};
		},
	};
}

export class PlatformStateChangedEvent {
	declare ["constructor"]: typeof PlatformStateChangedEvent;
	static plugin = PLUGIN_NAME;
	static type = "event" as const;
	static src = "instance" as const;
	static dst = "controller" as const;
	static jsonSchema: JsonSchema = {
		type: "object",
		properties: {
			instanceId: { type: "integer" },
			platformName: { type: "string" },
			forceName: { type: "string" },
		},
		required: ["instanceId", "platformName", "forceName"],
		additionalProperties: false,
	};

	instanceId: number;
	platformName: string;
	forceName: string;

	constructor(json: { instanceId: number; platformName: string; forceName: string }) {
		this.instanceId = json.instanceId;
		this.platformName = json.platformName;
		this.forceName = json.forceName;
	}

	static fromJSON(json: { instanceId: number; platformName: string; forceName: string }) {
		return new PlatformStateChangedEvent(json);
	}

	toJSON() { return { instanceId: this.instanceId, platformName: this.platformName, forceName: this.forceName }; }
}


export type OperationType = "transfer" | "export" | "import";

export type TransferStatus =
	| "queued"
	| "preparing"
	| "transporting"
	| "in_progress"
	| "awaiting_validation"
	| "awaiting_completion"
	| "completed"
	| "failed"
	| "cleanup_failed"
	| "error"
	| "unknown";

export interface PhaseRecord {
	startMs: number;
	endMs?: number;
	durationMs?: number;
}

export interface ActiveTransfer {
	platformUid?: string;
	lineage?: string | null;
	lineageGeneration?: number | null;
	sourceRollback?: import("./shared/recovery").SourceRollback;
	lateDestinationCleanup?: boolean;
 destinationJobId?: string; jobEpoch?: string; jobObservation?: import("./shared/job-status").JobObservation;
	awaitingLateVerdict?: boolean;
	queuedRequestId?: string;
	timingPendingRecovery?: boolean;
	timing?: OperationTiming;
	observedDurationMs?: number;
	transferId: string;
	operationType: OperationType;
	exportId: string | null;
	sourceExportId?: string | null;
	artifactSizeBytes: number | null;
	platformName: string;
	platformIndex: number;
	forceName: string;
	sourceInstanceId: number;
	sourceInstanceName: string | null;
	targetInstanceId: number;
	targetInstanceName: string | null;
	startedAt: number;
	status: TransferStatus;
	completedAt?: number | null;
	failedAt?: number | null;
	error?: string | null;
	payloadMetrics?: PayloadMetrics;
	exportMetrics?: ExportMetrics | null;
	importMetrics?: ImportMetrics | null;
	validationResult?: ValidationResult | null;
	failedStage?: ValidationResult['failedStage'];
	sourceVerification?: { itemCounts: Record<string, number>; fluidCounts: Record<string, number> };
	validationTimeout?: ReturnType<typeof setTimeout> | null;
	armedValidationTimeoutMs?: number | null;
	phases?: Record<string, PhaseRecord>;
	metricsRecorded?: boolean;
	passengers?: PassengerManifestEntry[];
}


export interface StoredExport {
	timing?: OperationTiming;
	exportId: string;
	sourceExportId: string;
	platformName: string;
	platformIndex: number | null;
	instanceId: number;
	exportData: Record<string, unknown>;
	exportMetrics: ExportMetrics | null;
	timestamp: number;
	size: number;
}


export interface PersistedTransactionLog {
	transferId: string;
	transferInfo: { [K in keyof ActiveTransfer]?: ActiveTransfer[K] | null } & { status: string; sourceRestored?: boolean };
	summary: Record<string, unknown>;
	events: TransactionLogEntryModel[];
	savedAt: number;
}


export interface SubscriptionState {
	tree: boolean;
	transfers: boolean;
	logs: boolean;
	transferId: string | null;
}

export type InstanceRecordLike = {
	id: number;
	isDeleted: boolean;
	status?: string;
	config: { get(key: string): unknown };
};

export interface PendingTransferIntent {
	transferId: string;
	sourceExportId?: string | null;
	sourceInstanceId: number;
	sourcePlatformIndex: number;
	sourcePlatformName: string;
	forceName: string;
	targetInstanceId: number;
	startedAt: number;
	exportId: string | null;
	lineage?: string | null;
	lineageGeneration?: number | null;
	rollbackPending?: boolean;
	rollbackContradiction?: { state: string; observedAt: number } | null;
}

export interface IControllerPlugin {
	handlePlatformExport(event: PlatformExportEvent): Promise<void>;
	handleImportOperationCompleteEvent(event: ImportOperationCompleteEvent): Promise<void>;
	recoveryReservations?: Map<number, { epoch: string; mode: import("./shared/recovery").PlatformSourceOfTruth; allowAdoption: boolean }>;
	lineagePresence(wanted: Map<number, Set<string>>): Promise<Map<string, { state: "present" } | { state: "absent" } | { state: "unknown"; reason: string }>>;
	lineageRegistry: {
		loadError: string | null;
		precheckTransfer(commit: import("./shared/lineage").TransferCommit): string | null;
		commitTransfer(commit: import("./shared/lineage").TransferCommit): Promise<"write" | "noop">;
	};
	pendingTransfers?: Map<string, PendingTransferIntent>;
	persistPendingTransfer(intent: PendingTransferIntent): void;
	persistPendingTransfers(requiredTransferId?: string): Promise<void>;
	removePendingTransfer(transferId: string): void;
	isInstanceOnline(instanceId: number): boolean;
	autoPauseRefusal(instanceId: number, role: "source" | "destination"): Promise<string | null>;
	controller: {
		wsServer: { controlConnections: Map<number, unknown> };
		sendTo: (target: { instanceId: number }, message: unknown) => Promise<any>;
		config?: { get(field: string): unknown };
		instances: {
			get(id: number): InstanceRecordLike | undefined;
			values(): IterableIterator<InstanceRecordLike>;
		};
		hosts: Map<number, { id: number; name: string; connected: boolean; isDeleted: boolean }>;
	};
	logger: {
		info(msg: string): void;
		warn(msg: string): void;
		error(msg: string): void;
		verbose(msg: string): void;
	};
	gatewayConfig?: { portalOf(instanceId: number): import("./shared/portals").PortalAssignment | null };
	platformStorage: Map<string, StoredExport>;
	platformTree: {
		resolvePlatformUid(instanceId: number, platformIndex: number, forceName: string, expectedUid?: string): Promise<string>;
		resolveInstanceName: (instanceId: number) => string | null;
		buildPlatformTree: (forceName?: string) => Promise<{ hosts: unknown[]; unassignedInstances: unknown[] }>;
		resolveTargetInstance: (target: unknown) => { id: number; instance: unknown } | null;
		requestInstancePlatforms: (instanceId: number, forceName?: string) => Promise<{ platforms: Array<Record<string, unknown>>; autoPause?: boolean; error: string | null }>;
	};
	platformDepartureTimes: Map<string, number>;
	activeTransfers: Map<string, ActiveTransfer>;
	surfaceExportSubscriptions: Map<{ send: (event: unknown) => void; user: { checkPermission: (permission: string) => void } }, SubscriptionState>;
	transactionLogs: Map<string, TransactionLogEntryModel[]>;
	persistedTransactionLogs: PersistedTransactionLog[];
	transactionLogPath: string;
	auditLedgerPath: string;
	auditIndex: Map<string, AuditRow>;
	auditRevisions: Map<string, number>;
	recordAuditRow(row: AuditRow): Promise<void>;
	recordTransferStarted(transfer: ActiveTransfer): Promise<void>;
	transactionLogLoadError: string | null;
	lastTreeForceName: string;
	treeRevision: number;
	transferRevision: number;
	logRevision: number;
	txLogger: {
		getObservedDuration(transfer: ActiveTransfer): number | null;
		rejectObservation(id: string, request: Record<string, unknown>, error: string): Promise<void>;
		beginObservation(id: string): import("./shared/timing").TimingClockContract;
		bindObservation(from: string, to: string): void;
		clock(id: string): import("./shared/timing").TimingClockContract;
		logTransactionEvent(transferId: string, eventType: string, message: string, data?: Record<string, unknown>, atMs?: number | null): void;
		buildTransferSummary(transferId: string, transfer: ActiveTransfer, lastEventAt: number | null): TransferSummaryModel;
		buildTransferInfo(transfer: ActiveTransfer): Record<string, unknown>;
		buildDetailedTransferSummary(transferId: string, transfer: ActiveTransfer, lastEventAt: number | null): Record<string, unknown>;
		getLastEventTimestamp(transferId: string): number | null;
		persistTransactionLog(transferId: string): Promise<void>;
		archiveRecycledTransferId(transferId: string, startedAt: number | null | undefined): Promise<void>;
		startPhase(transferId: string, phaseName: string): void;
		endPhase(transferId: string, phaseName: string): number;
		buildPhaseSummary(transfer: ActiveTransfer): Record<string, number>;
	};
	subscriptions: {
		emitLogUpdate(transferId: string, event: TransactionLogEntryModel | null): void;
		emitTransferUpdate(transfer: ActiveTransfer): void;
		queueTreeBroadcast(forceName?: string): void;
	};
	persistStorage(): Promise<void>;
}

export type ExportVerification = {
	item_counts?: Record<string, number>;
	fluid_counts?: Record<string, number>;
};

export type ExportStats = {
	entity_count?: number;
	tile_count?: number;
};

export type ExportData = {
	platform_uid?: string;
	purpose?: string;
	lineage?: string;
	generation?: number;
	_lineage?: string;
	_lineageGeneration?: number;
	force_name?: string;
	compressed?: boolean;
	compression?: string;
	payload?: string;
	stats?: ExportStats;
	verification?: ExportVerification;
	platform?: { force?: string };
	platform_name?: string;
	_transferId?: string;
	_sourceInstanceId?: number;
	_operationId?: string;
	[extra: string]: unknown;
};

export type OperationOptions = {
	platformUid?: string;
	operationId?: string;
	exportId?: string | null;
	sourceExportId?: string | null;
	artifactSizeBytes?: number | null;
	platformName?: string;
	platformIndex?: number;
	forceName?: string;
	sourceInstanceId?: number;
	sourceInstanceName?: string | null;
	targetInstanceId?: number;
	targetInstanceName?: string | null;
	status?: TransferStatus;
	startedAt?: number;
	completedAt?: number | null;
	failedAt?: number | null;
	error?: string | null;
	payloadMetrics?: Record<string, unknown> | null;
	exportMetrics?: Record<string, unknown> | null;
	importMetrics?: Record<string, unknown> | null;
	phases?: Record<string, { startMs?: number; endMs?: number; durationMs?: number }>;
	validationResult?: Record<string, unknown> | null;
	sourceVerification?: { itemCounts?: Record<string, number>; fluidCounts?: Record<string, number> } | null;
};

export type ExportResult = { success: boolean; exportId?: string; admissionUncertain?: boolean; error?: string };

export type ImportResult = { success: boolean; error?: string; jobId?: string; epoch?: string; attemptId?: string; admissionUncertain?: boolean };

export type PendingTransfer = {
	platform_index?: number;
	platform_name?: string;
	force_name?: string;
	destination_instance_id?: number;
	job_id?: number | string;
};
