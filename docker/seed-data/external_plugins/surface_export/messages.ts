import type {
	HostNodeModel,
	InstanceNodeModel,
	PlatformModel,
	StoredExportSummaryModel,
	TransactionLogEntryModel,
	TransferSummaryModel,
} from "./shared/dto";
export type {
	HostNodeModel,
	InstanceNodeModel,
	PlatformModel,
	StoredExportSummaryModel,
	TransactionLogEntryModel,
	TransferSummaryModel,
} from "./shared/dto";
const PLUGIN_NAME = "surface_export";

export const PERMISSIONS = {
	LIST_EXPORTS: `${PLUGIN_NAME}.exports.list`,
	TRANSFER_EXPORTS: `${PLUGIN_NAME}.exports.transfer`,
	UI_VIEW: `${PLUGIN_NAME}.ui.view`,
	VIEW_LOGS: `${PLUGIN_NAME}.logs.view`,
} as const;

// ── Shared JSON schema types ────────────────────────────────────────────────

type JsonSchema = Record<string, unknown>;

export interface SimpleResponse {
	success: boolean;
	error?: string;
}

// ── Request / Event classes ─────────────────────────────────────────────────

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
			forceName: { type: "string", default: "player" },
			targetInstanceId: { type: ["integer", "null"], default: null },
		},
		required: ["platformIndex"],
		additionalProperties: false,
	};

	platformIndex: number;
	forceName: string;
	targetInstanceId: number | null;

	constructor(json: { platformIndex: number; forceName?: string; targetInstanceId?: number | null }) {
		this.platformIndex = json.platformIndex;
		this.forceName = json.forceName || "player";
		this.targetInstanceId = json.targetInstanceId ?? null;
	}

	static fromJSON(json: { platformIndex: number; forceName?: string; targetInstanceId?: number | null }) {
		return new ExportPlatformRequest(json);
	}

	toJSON() {
		return { platformIndex: this.platformIndex, forceName: this.forceName, targetInstanceId: this.targetInstanceId };
	}

	static Response = {
		jsonSchema: {
			type: "object",
			properties: {
				success: { type: "boolean" },
				exportId: { type: "string" },
				error: { type: "string" },
			},
			required: ["success"],
		} as JsonSchema,
		fromJSON(json: unknown) { return json as SimpleResponse & { exportId?: string }; },
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
			forceName: { type: "string", default: "player" },
			platformName: { type: ["string", "null"], default: null },
		},
		required: ["targetInstanceId", "exportData"],
		additionalProperties: false,
	};

	targetInstanceId: number;
	exportData: Record<string, unknown>;
	forceName: string;
	platformName: string | null;

	constructor(json: { targetInstanceId: number; exportData: Record<string, unknown>; forceName?: string; platformName?: string | null }) {
		this.targetInstanceId = json.targetInstanceId;
		this.exportData = json.exportData;
		this.forceName = json.forceName || "player";
		this.platformName = json.platformName ?? null;
	}

	static fromJSON(json: { targetInstanceId: number; exportData: Record<string, unknown>; forceName?: string; platformName?: string | null }) {
		return new ImportUploadedExportRequest(json);
	}

	toJSON() {
		return { targetInstanceId: this.targetInstanceId, exportData: this.exportData, forceName: this.forceName, platformName: this.platformName };
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
			forceName: { type: "string", default: "player" },
		},
		required: ["sourceInstanceId", "sourcePlatformIndex"],
		additionalProperties: false,
	};

	sourceInstanceId: number;
	sourcePlatformIndex: number;
	forceName: string;

	constructor(json: { sourceInstanceId: number; sourcePlatformIndex: number; forceName?: string }) {
		this.sourceInstanceId = json.sourceInstanceId;
		this.sourcePlatformIndex = json.sourcePlatformIndex;
		this.forceName = json.forceName || "player";
	}

	static fromJSON(json: { sourceInstanceId: number; sourcePlatformIndex: number; forceName?: string }) {
		return new ExportPlatformForDownloadRequest(json);
	}

	toJSON() {
		return { sourceInstanceId: this.sourceInstanceId, sourcePlatformIndex: this.sourcePlatformIndex, forceName: this.forceName };
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
	instanceId: number;
	exportData: Record<string, unknown>;
	timestamp: number;
	exportMetrics: ExportMetrics | null;

	constructor(json: { exportId: string; platformName: string; instanceId: number; exportData: Record<string, unknown>; timestamp: number; exportMetrics?: ExportMetrics | null }) {
		this.exportId = json.exportId;
		this.platformName = json.platformName;
		this.instanceId = json.instanceId;
		this.exportData = json.exportData;
		this.timestamp = json.timestamp;
		this.exportMetrics = json.exportMetrics || null;
	}

	static fromJSON(json: { exportId: string; platformName: string; instanceId: number; exportData: Record<string, unknown>; timestamp: number; exportMetrics?: ExportMetrics | null }) {
		return new PlatformExportEvent(json);
	}

	toJSON() {
		return {
			exportId: this.exportId, platformName: this.platformName, instanceId: this.instanceId,
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
		},
		required: ["exportId", "exportData"],
		additionalProperties: false,
	};

	exportId: string;
	exportData: Record<string, unknown>;
	forceName: string;

	constructor(json: { exportId: string; exportData: Record<string, unknown>; forceName?: string }) {
		this.exportId = json.exportId;
		this.exportData = json.exportData;
		this.forceName = json.forceName || "player";
	}

	static fromJSON(json: { exportId: string; exportData: Record<string, unknown>; forceName?: string }) {
		return new ImportPlatformRequest(json);
	}

	toJSON() { return { exportId: this.exportId, exportData: this.exportData, forceName: this.forceName }; }

	static Response = {
		jsonSchema: { type: "object", properties: { success: { type: "boolean" }, error: { type: "string" } }, required: ["success"] } as JsonSchema,
		fromJSON(json: unknown) { return json as SimpleResponse & { platformName?: string }; },
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

	constructor() { /* no fields */ }
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
		},
		required: ["exportId", "targetInstanceId"],
		additionalProperties: false,
	};

	exportId: string;
	targetInstanceId: number;

	constructor(json: { exportId: string; targetInstanceId: number }) {
		this.exportId = json.exportId;
		this.targetInstanceId = json.targetInstanceId;
	}

	static fromJSON(json: { exportId: string; targetInstanceId: number }) { return new TransferPlatformRequest(json); }
	toJSON() { return { exportId: this.exportId, targetInstanceId: this.targetInstanceId }; }

	static Response = {
		jsonSchema: { type: "object", properties: { success: { type: "boolean" }, error: { type: "string" }, transferId: { type: "string" }, message: { type: "string" } }, required: ["success"] } as JsonSchema,
		fromJSON(json: unknown) { return json as SimpleResponse & { transferId?: string; message?: string }; },
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
			sourceInstanceId: { type: "integer" },
			sourcePlatformIndex: { type: "integer" },
			targetInstanceId: { type: "integer" },
			forceName: { type: "string", default: "player" },
		},
		required: ["sourceInstanceId", "sourcePlatformIndex", "targetInstanceId"],
		additionalProperties: false,
	};

	sourceInstanceId: number;
	sourcePlatformIndex: number;
	targetInstanceId: number;
	forceName: string;

	constructor(json: { sourceInstanceId: number; sourcePlatformIndex: number; targetInstanceId: number; forceName?: string }) {
		this.sourceInstanceId = json.sourceInstanceId;
		this.sourcePlatformIndex = json.sourcePlatformIndex;
		this.targetInstanceId = json.targetInstanceId;
		this.forceName = json.forceName || "player";
	}

	static fromJSON(json: { sourceInstanceId: number; sourcePlatformIndex: number; targetInstanceId: number; forceName?: string }) {
		return new StartPlatformTransferRequest(json);
	}

	toJSON() {
		return { sourceInstanceId: this.sourceInstanceId, sourcePlatformIndex: this.sourcePlatformIndex, targetInstanceId: this.targetInstanceId, forceName: this.forceName };
	}

	static Response = {
		jsonSchema: { type: "object", properties: { success: { type: "boolean" }, error: { type: "string" }, transferId: { type: "string" }, exportId: { type: "string" }, message: { type: "string" } }, required: ["success"] } as JsonSchema,
		fromJSON(json: unknown) { return json as SimpleResponse & { transferId?: string; exportId?: string; message?: string }; },
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
		jsonSchema: { type: "object", properties: { instanceId: { type: "integer" }, instanceName: { type: "string" }, forceName: { type: "string" }, platforms: { type: "array" } }, required: ["instanceId", "instanceName", "forceName", "platforms"] } as JsonSchema,
		fromJSON(json: unknown) { return json as { instanceId: number; instanceName: string; forceName: string; platforms: PlatformModel[] }; },
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

	static Response = {
		jsonSchema: { type: "object", properties: { success: { type: "boolean" }, error: { type: "string" } }, required: ["success"] } as JsonSchema,
		fromJSON(json: unknown) { return json as SimpleResponse; },
	};
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
	metrics?: Record<string, number>;

	constructor(json: { transferId: string; platformName: string; sourceInstanceId: number; success: boolean; validation?: ValidationResult; metrics?: Record<string, number> }) {
		this.transferId = json.transferId;
		this.platformName = json.platformName;
		this.sourceInstanceId = json.sourceInstanceId;
		this.success = json.success;
		this.validation = json.validation;
		this.metrics = json.metrics;
	}

	static fromJSON(json: { transferId: string; platformName: string; sourceInstanceId: number; success: boolean; validation?: ValidationResult; metrics?: Record<string, number> }) {
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
			durationTicks: { type: ["integer", "null"] },
			entityCount: { type: ["integer", "null"] },
			metrics: { type: ["object", "null"] },
		},
		required: ["operationId", "platformName", "instanceId", "success"],
		additionalProperties: false,
	};

	operationId: string;
	platformName: string;
	instanceId: number;
	success: boolean;
	error: string | null;
	durationTicks: number | null;
	entityCount: number | null;
	metrics: Record<string, number> | null;

	constructor(json: { operationId: string; platformName: string; instanceId: number; success: boolean; error?: string | null; durationTicks?: number | null; entityCount?: number | null; metrics?: Record<string, number> | null }) {
		this.operationId = json.operationId;
		this.platformName = json.platformName;
		this.instanceId = json.instanceId;
		this.success = json.success;
		this.error = json.error ?? null;
		this.durationTicks = json.durationTicks ?? null;
		this.entityCount = json.entityCount ?? null;
		this.metrics = json.metrics ?? null;
	}

	static fromJSON(json: { operationId: string; platformName: string; instanceId: number; success: boolean; error?: string | null; durationTicks?: number | null; entityCount?: number | null; metrics?: Record<string, number> | null }) {
		return new ImportOperationCompleteEvent(json);
	}

	toJSON() {
		return { operationId: this.operationId, platformName: this.platformName, instanceId: this.instanceId, success: this.success, error: this.error, durationTicks: this.durationTicks, entityCount: this.entityCount, metrics: this.metrics };
	}
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
		},
		required: ["platformIndex", "platformName"],
		additionalProperties: false,
	};

	platformIndex: number;
	platformName: string;
	forceName: string;

	constructor(json: { platformIndex: number; platformName: string; forceName?: string }) {
		this.platformIndex = json.platformIndex;
		this.platformName = json.platformName;
		this.forceName = json.forceName || "player";
	}

	static fromJSON(json: { platformIndex: number; platformName: string; forceName?: string }) { return new DeleteSourcePlatformRequest(json); }
	toJSON() { return { platformIndex: this.platformIndex, platformName: this.platformName, forceName: this.forceName }; }

	static Response = {
		jsonSchema: { type: "object", properties: { success: { type: "boolean" }, error: { type: "string" } }, required: ["success"] } as JsonSchema,
		fromJSON(json: unknown) { return json as SimpleResponse; },
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
			platformName: { type: "string" },
			forceName: { type: "string", default: "player" },
		},
		required: ["platformName"],
		additionalProperties: false,
	};

	platformName: string;
	forceName: string;

	constructor(json: { platformName: string; forceName?: string }) {
		this.platformName = json.platformName;
		this.forceName = json.forceName || "player";
	}

	static fromJSON(json: { platformName: string; forceName?: string }) { return new UnlockSourcePlatformRequest(json); }
	toJSON() { return { platformName: this.platformName, forceName: this.forceName }; }

	static Response = {
		jsonSchema: { type: "object", properties: { success: { type: "boolean" }, error: { type: "string" } }, required: ["success"] } as JsonSchema,
		fromJSON(json: unknown) { return json as SimpleResponse; },
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
		jsonSchema: { type: "object", properties: { success: { type: "boolean" }, transferId: { type: "string" }, events: { type: "array" }, transferInfo: { type: ["object", "null"] }, summary: { type: ["object", "null"] }, error: { type: "string" } }, required: ["success"] } as JsonSchema,
		fromJSON(json: unknown) {
			return json as SimpleResponse & {
				transferId?: string;
				events?: TransactionLogEntryModel[];
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

// ── Shared domain types (used by node-side and web-side) ────────────────────

export interface ExportMetrics {
	requestExportAndLockMs?: number;
	waitForControllerStoreMs?: number;
	controllerExportPrepTotalMs?: number;
	instanceAsyncExportTicks?: number;
	instanceAsyncExportMs?: number;
	instanceAsyncExportSeconds?: number;
	exportedEntityCount?: number;
	exportedTileCount?: number;
	atomicBeltEntitiesScanned?: number;
	atomicBeltItemStacksCaptured?: number;
	uncompressedPayloadBytes?: number;
	compressedPayloadBytes?: number;
	compressionReductionPct?: number;
	scheduleRecordCount?: number;
	scheduleInterruptCount?: number;
}

export interface ImportMetrics {
	total_ticks: number;
	tiles_ms: number;
	entities_ms: number;
	fluids_ms: number;
	belts_ms: number;
	state_ms: number;
	validation_ms: number;
	total_ms: number;
	tiles_placed: number;
	entities_created: number;
	entities_failed: number;
	fluids_restored: number;
	belt_items_restored: number;
	circuits_connected: number;
	total_items: number;
	total_fluids: number;
	[key: string]: number;
}

export interface PayloadMetrics {
	isCompressed: boolean;
	compressionType: string;
	payloadSizeKB: number | null;
	entityCount: number;
	tileCount: number;
	uniqueItemTypes: number;
	totalItemCount: number;
	uniqueFluidTypes: number;
	totalFluidVolume: number;
}

export interface ValidationResult {
	itemCountMatch: boolean;
	fluidCountMatch: boolean;
	entityCount?: number;
	mismatchDetails?: string;
	expectedItemCounts?: Record<string, number>;
	actualItemCounts?: Record<string, number>;
	expectedFluidCounts?: Record<string, number>;
	actualFluidCounts?: Record<string, number>;
	entityTypeBreakdown?: Record<string, number>;
	failedEntityLosses?: { items: Record<string, number>; fluids: Record<string, number> };
	highTempAggregates?: Record<string, { expectedEnergy: number; actualEnergy: number; reconciled: boolean }>;
	// Post-LossAnalysis fields
	postActivation?: boolean;
	totalExpectedItems?: number;
	totalActualItems?: number;
	totalExpectedFluids?: number;
	totalActualFluids?: number;
	itemTypesExpected?: number;
	itemTypesActual?: number;
	fluidTypesExpected?: number;
	fluidTypesActual?: number;
	fluidReconciliation?: {
		highTempThreshold: number;
		rawFluidDelta: number;
		reconciledFluidLoss: number;
		lowTempLoss: number;
		highTempReconciledLoss: number;
		fluidPreservedPct: number;
		highTempAggregates?: Record<string, { expected: number; actual: number; delta: number; reconciled: boolean; expectedEnergy: number; actualEnergy: number }>;
	};
	[key: string]: unknown;
}

export type OperationType = "transfer" | "export" | "import";

export type TransferStatus =
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
	transferId: string;
	operationType: OperationType;
	exportId: string | null;
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
	sourceVerification?: { itemCounts: Record<string, number>; fluidCounts: Record<string, number> };
	validationTimeout?: ReturnType<typeof setTimeout> | null;
	phases?: Record<string, PhaseRecord>;
}


export interface StoredExport {
	exportId: string;
	platformName: string;
	instanceId: number;
	exportData: Record<string, unknown>;
	exportMetrics: ExportMetrics | null;
	timestamp: number;
	size: number;
}


export interface PersistedTransactionLog {
	transferId: string;
	transferInfo: Partial<ActiveTransfer> & { status: string };
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

/** Shared interface implemented by ControllerPlugin; used by lib/ modules to avoid circular imports. */
export interface IControllerPlugin {
	controller: {
		wsServer: { controlConnections: Map<number, unknown> };
		sendTo: (target: { instanceId: number }, message: unknown) => Promise<any>;
		instances: Map<number, { id: number; isDeleted: boolean; status?: string; config: { get(key: string): unknown } }>;
		hosts: Map<number, { id: number; name: string; connected: boolean; isDeleted: boolean }>;
	};
	logger: {
		info(msg: string): void;
		warn(msg: string): void;
		error(msg: string): void;
		verbose(msg: string): void;
	};
	platformStorage: Map<string, StoredExport>;
	platformTree: {
		resolveInstanceName: (instanceId: number) => string | null;
		buildPlatformTree: (forceName?: string) => Promise<{ hosts: unknown[]; unassignedInstances: unknown[] }>;
		resolveTargetInstance: (target: unknown) => { id: number; instance: unknown } | null;
	};
	platformDepartureTimes: Map<string, number>;
	activeTransfers: Map<string, ActiveTransfer>;
	surfaceExportSubscriptions: Map<{ send: (event: unknown) => void; user: { checkPermission: (permission: string) => void } }, SubscriptionState>;
	transactionLogs: Map<string, TransactionLogEntryModel[]>;
	persistedTransactionLogs: PersistedTransactionLog[];
	transactionLogPath: string;
	lastTreeForceName: string;
	treeRevision: number;
	transferRevision: number;
	logRevision: number;
	txLogger: {
		normalizeTransferStatus(status: string): string;
		logTransactionEvent(transferId: string, eventType: string, message: string, data?: Record<string, unknown>): void;
		buildTransferSummaryModel(transferId: string, transfer: ActiveTransfer, lastEventAt: number | null): TransferSummaryModel;
		buildTransferInfo(transfer: ActiveTransfer): Record<string, unknown>;
		buildDetailedTransferSummaryModel(transferId: string, transfer: ActiveTransfer, lastEventAt: number | null): Record<string, unknown>;
		getLastEventTimestamp(transferId: string): number | null;
		persistTransactionLog(transferId: string): Promise<void>;
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

/** Verification counts embedded in exported platform JSON (from Lua serializer). */
export type ExportVerification = {
	item_counts?: Record<string, number>;
	fluid_counts?: Record<string, number>;
};

/** Entity/tile counts embedded in exported platform JSON. */
export type ExportStats = {
	entity_count?: number;
	tile_count?: number;
};

/** Exported platform payload as produced by the Lua serializer. */
export type ExportData = {
	compressed?: boolean;
	compression?: string;
	payload?: string;
	stats?: ExportStats;
	verification?: ExportVerification;
	platform?: { force?: string; index?: number };
	platform_name?: string;
	_transferId?: string;
	_sourceInstanceId?: number;
	_operationId?: string;
	[extra: string]: unknown;
};

/** Options for creating a new operation record on the controller. */
export type OperationOptions = {
	operationId?: string;
	exportId?: string | null;
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

/** Result returned from Lua export polling. */
export type ExportResult = { success: boolean; exportId?: string; error?: string };

/** Result returned from Lua import operation. */
export type ImportResult = { success: boolean; error?: string };

/** Pending transfer state tracked by the instance plugin. */
export type PendingTransfer = {
	platform_index?: number;
	platform_name?: string;
	force_name?: string;
	destination_instance_id?: number;
	job_id?: number | string;
};
