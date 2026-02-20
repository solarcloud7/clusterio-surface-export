"use strict";

const PLUGIN_NAME = "surface_export";
const PERMISSIONS = {
	LIST_EXPORTS: `${PLUGIN_NAME}.exports.list`,
	TRANSFER_EXPORTS: `${PLUGIN_NAME}.exports.transfer`,
	UI_VIEW: `${PLUGIN_NAME}.ui.view`,
	VIEW_LOGS: `${PLUGIN_NAME}.logs.view`,
};

class ExportPlatformRequest {
	static plugin = PLUGIN_NAME;
	static type = "request";
	static src = ["controller", "instance"];
	static dst = "instance";
	static jsonSchema = {
		type: "object",
		properties: {
			platformIndex: { type: "integer" },
			forceName: { type: "string", default: "player" },
			targetInstanceId: { type: ["integer", "null"], default: null },
		},
		required: ["platformIndex"],
		additionalProperties: false,
	};

	constructor(json) {
		this.platformIndex = json.platformIndex;
		this.forceName = json.forceName || "player";
		this.targetInstanceId = json.targetInstanceId ?? null;
	}

	static fromJSON(json) {
		return new ExportPlatformRequest(json);
	}

	toJSON() {
		return {
			platformIndex: this.platformIndex,
			forceName: this.forceName,
			targetInstanceId: this.targetInstanceId,
		};
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
		},
		fromJSON(json) {
			return json;
		},
	};
}

class GetStoredExportRequest {
	static plugin = PLUGIN_NAME;
	static type = "request";
	static src = "control";
	static dst = "controller";
	static permission = PERMISSIONS.LIST_EXPORTS;
	static jsonSchema = {
		type: "object",
		properties: {
			exportId: { type: "string" },
		},
		required: ["exportId"],
		additionalProperties: false,
	};

	constructor(json) {
		this.exportId = json.exportId;
	}

	static fromJSON(json) {
		return new GetStoredExportRequest(json);
	}

	toJSON() {
		return {
			exportId: this.exportId,
		};
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
		},
		fromJSON(json) {
			return json;
		},
	};
}

class ImportUploadedExportRequest {
	static plugin = PLUGIN_NAME;
	static type = "request";
	static src = "control";
	static dst = "controller";
	static permission = PERMISSIONS.TRANSFER_EXPORTS;
	static jsonSchema = {
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

	constructor(json) {
		this.targetInstanceId = json.targetInstanceId;
		this.exportData = json.exportData;
		this.forceName = json.forceName || "player";
		this.platformName = json.platformName ?? null;
	}

	static fromJSON(json) {
		return new ImportUploadedExportRequest(json);
	}

	toJSON() {
		return {
			targetInstanceId: this.targetInstanceId,
			exportData: this.exportData,
			forceName: this.forceName,
			platformName: this.platformName,
		};
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
		},
		fromJSON(json) {
			return json;
		},
	};
}

class ExportPlatformForDownloadRequest {
	static plugin = PLUGIN_NAME;
	static type = "request";
	static src = "control";
	static dst = "controller";
	static permission = PERMISSIONS.TRANSFER_EXPORTS;
	static jsonSchema = {
		type: "object",
		properties: {
			sourceInstanceId: { type: "integer" },
			sourcePlatformIndex: { type: "integer" },
			forceName: { type: "string", default: "player" },
		},
		required: ["sourceInstanceId", "sourcePlatformIndex"],
		additionalProperties: false,
	};

	constructor(json) {
		this.sourceInstanceId = json.sourceInstanceId;
		this.sourcePlatformIndex = json.sourcePlatformIndex;
		this.forceName = json.forceName || "player";
	}

	static fromJSON(json) {
		return new ExportPlatformForDownloadRequest(json);
	}

	toJSON() {
		return {
			sourceInstanceId: this.sourceInstanceId,
			sourcePlatformIndex: this.sourcePlatformIndex,
			forceName: this.forceName,
		};
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
		},
		fromJSON(json) {
			return json;
		},
	};
}
class GetPlatformTreeRequest {
	static plugin = PLUGIN_NAME;
	static type = "request";
	static src = "control";
	static dst = "controller";
	static permission = PERMISSIONS.UI_VIEW;
	static jsonSchema = {
		type: "object",
		properties: {
			forceName: { type: "string", default: "player" },
		},
		additionalProperties: false,
	};

	constructor(json = {}) {
		this.forceName = json.forceName || "player";
	}

	static fromJSON(json) {
		return new GetPlatformTreeRequest(json);
	}

	toJSON() {
		return {
			forceName: this.forceName,
		};
	}

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
		},
		fromJSON(json) {
			return json;
		},
	};
}

class ListTransactionLogsRequest {
	static plugin = PLUGIN_NAME;
	static type = "request";
	static src = "control";
	static dst = "controller";
	static permission = PERMISSIONS.VIEW_LOGS;
	static jsonSchema = {
		type: "object",
		properties: {
			limit: { type: "integer", minimum: 1, maximum: 500, default: 50 },
		},
		additionalProperties: false,
	};

	constructor(json = {}) {
		this.limit = json.limit || 50;
	}

	static fromJSON(json) {
		return new ListTransactionLogsRequest(json);
	}

	toJSON() {
		return {
			limit: this.limit,
		};
	}

	static Response = {
		jsonSchema: {
			type: "array",
			items: {
				type: "object",
				properties: {
					transferId: { type: "string" },
					platformName: { type: "string" },
					sourceInstanceId: { type: "integer" },
					sourceInstanceName: { type: ["string", "null"] },
					targetInstanceId: { type: "integer" },
					targetInstanceName: { type: ["string", "null"] },
					status: { type: "string" },
					startedAt: { type: "number" },
					completedAt: { type: ["number", "null"] },
					failedAt: { type: ["number", "null"] },
					error: { type: ["string", "null"] },
					lastEventAt: { type: ["number", "null"] },
				},
				required: [
					"transferId",
					"platformName",
					"sourceInstanceId",
					"sourceInstanceName",
					"targetInstanceId",
					"targetInstanceName",
					"status",
					"startedAt",
					"completedAt",
					"failedAt",
					"error",
					"lastEventAt",
				],
			},
		},
		fromJSON(json) {
			return json;
		},
	};
}
class SetSurfaceExportSubscriptionRequest {
	static plugin = PLUGIN_NAME;
	static type = "request";
	static src = "control";
	static dst = "controller";
	static permission = PERMISSIONS.UI_VIEW;
	static jsonSchema = {
		type: "object",
		properties: {
			tree: { type: "boolean", default: false },
			transfers: { type: "boolean", default: false },
			logs: { type: "boolean", default: false },
			transferId: { type: ["string", "null"], default: null },
		},
		additionalProperties: false,
	};

	constructor(json = {}) {
		this.tree = json.tree || false;
		this.transfers = json.transfers || false;
		this.logs = json.logs || false;
		this.transferId = json.transferId || null;
	}

	static fromJSON(json) {
		return new SetSurfaceExportSubscriptionRequest(json);
	}

	toJSON() {
		return {
			tree: this.tree,
			transfers: this.transfers,
			logs: this.logs,
			transferId: this.transferId,
		};
	}
}

class SurfaceExportTreeUpdateEvent {
	static plugin = PLUGIN_NAME;
	static type = "event";
	static src = "controller";
	static dst = "control";
	static jsonSchema = {
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

	constructor(json) {
		this.revision = json.revision;
		this.generatedAt = json.generatedAt;
		this.forceName = json.forceName;
		this.tree = json.tree;
	}

	static fromJSON(json) {
		return new SurfaceExportTreeUpdateEvent(json);
	}

	toJSON() {
		return {
			revision: this.revision,
			generatedAt: this.generatedAt,
			forceName: this.forceName,
			tree: this.tree,
		};
	}
}

class SurfaceExportTransferUpdateEvent {
	static plugin = PLUGIN_NAME;
	static type = "event";
	static src = "controller";
	static dst = "control";
	static jsonSchema = {
		type: "object",
		properties: {
			revision: { type: "integer" },
			generatedAt: { type: "number" },
			transfer: { type: "object" },
		},
		required: ["revision", "generatedAt", "transfer"],
		additionalProperties: false,
	};

	constructor(json) {
		this.revision = json.revision;
		this.generatedAt = json.generatedAt;
		this.transfer = json.transfer;
	}

	static fromJSON(json) {
		return new SurfaceExportTransferUpdateEvent(json);
	}

	toJSON() {
		return {
			revision: this.revision,
			generatedAt: this.generatedAt,
			transfer: this.transfer,
		};
	}
}

class SurfaceExportLogUpdateEvent {
	static plugin = PLUGIN_NAME;
	static type = "event";
	static src = "controller";
	static dst = "control";
	static jsonSchema = {
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

	constructor(json) {
		this.revision = json.revision;
		this.generatedAt = json.generatedAt;
		this.transferId = json.transferId;
		this.event = json.event;
		this.transferInfo = json.transferInfo;
		this.summary = json.summary;
	}

	static fromJSON(json) {
		return new SurfaceExportLogUpdateEvent(json);
	}

	toJSON() {
		return {
			revision: this.revision,
			generatedAt: this.generatedAt,
			transferId: this.transferId,
			event: this.event,
			transferInfo: this.transferInfo,
			summary: this.summary,
		};
	}
}

class PlatformExportEvent {
	static plugin = PLUGIN_NAME;
	static type = "event";
	static src = "instance";
	static dst = "controller";
	static jsonSchema = {
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

	constructor(json) {
		this.exportId = json.exportId;
		this.platformName = json.platformName;
		this.instanceId = json.instanceId;
		this.exportData = json.exportData;
		this.timestamp = json.timestamp;
		this.exportMetrics = json.exportMetrics || null;
	}

	static fromJSON(json) {
		return new PlatformExportEvent(json);
	}

	toJSON() {
		return {
			exportId: this.exportId,
			platformName: this.platformName,
			instanceId: this.instanceId,
			exportData: this.exportData,
			timestamp: this.timestamp,
			exportMetrics: this.exportMetrics,
		};
	}
}

class ImportPlatformRequest {
	static plugin = PLUGIN_NAME;
	static type = "request";
	static src = ["controller", "instance"];
	static dst = "instance";
	static jsonSchema = {
		type: "object",
		properties: {
			exportId: { type: "string" },
			exportData: { type: "object" },
			forceName: { type: "string", default: "player" },
		},
		required: ["exportId", "exportData"],
		additionalProperties: false,
	};

	constructor(json) {
		this.exportId = json.exportId;
		this.exportData = json.exportData;
		this.forceName = json.forceName || "player";
	}

	static fromJSON(json) {
		return new ImportPlatformRequest(json);
	}

	toJSON() {
		return {
			exportId: this.exportId,
			exportData: this.exportData,
			forceName: this.forceName,
		};
	}

	static Response = {
		jsonSchema: {
			type: "object",
			properties: {
				success: { type: "boolean" },
				error: { type: "string" },
			},
			required: ["success"],
		},
		fromJSON(json) {
			return json;
		},
	};
}

class ListExportsRequest {
	static plugin = PLUGIN_NAME;
	static type = "request";
	static src = "control";
	static dst = "controller";
	static permission = PERMISSIONS.LIST_EXPORTS;
	static jsonSchema = {
		type: "object",
		properties: {},
		additionalProperties: false,
	};

	constructor() {}

	static fromJSON() {
		return new ListExportsRequest();
	}

	toJSON() {
		return {};
	}

	static Response = {
		jsonSchema: {
			type: "array",
			items: {
				type: "object",
				properties: {
					exportId: { type: "string" },
					platformName: { type: "string" },
					instanceId: { type: "integer" },
					timestamp: { type: "number" },
					size: { type: "integer" },
				},
				required: ["exportId", "platformName", "instanceId", "timestamp", "size"],
			},
		},
		fromJSON(json) {
			return json;
		},
	};
}

class TransferPlatformRequest {
	static plugin = PLUGIN_NAME;
	static type = "request";
	static src = ["control", "instance"];  // Allow both CLI and instance plugins
	static dst = "controller";
	static permission = PERMISSIONS.TRANSFER_EXPORTS;
	static jsonSchema = {
		type: "object",
		properties: {
			exportId: { type: "string" },
			targetInstanceId: { type: "integer" },
		},
		required: ["exportId", "targetInstanceId"],
		additionalProperties: false,
	};

	constructor(json) {
		this.exportId = json.exportId;
		this.targetInstanceId = json.targetInstanceId;
	}

	static fromJSON(json) {
		return new TransferPlatformRequest(json);
	}

	toJSON() {
		return {
			exportId: this.exportId,
			targetInstanceId: this.targetInstanceId,
		};
	}

	static Response = {
		jsonSchema: {
			type: "object",
			properties: {
				success: { type: "boolean" },
				error: { type: "string" },
				transferId: { type: "string" },
				message: { type: "string" },
			},
			required: ["success"],
		},
		fromJSON(json) {
			return json;
		},
	};
}
class StartPlatformTransferRequest {
	static plugin = PLUGIN_NAME;
	static type = "request";
	static src = "control";
	static dst = "controller";
	static permission = PERMISSIONS.TRANSFER_EXPORTS;
	static jsonSchema = {
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

	constructor(json) {
		this.sourceInstanceId = json.sourceInstanceId;
		this.sourcePlatformIndex = json.sourcePlatformIndex;
		this.targetInstanceId = json.targetInstanceId;
		this.forceName = json.forceName || "player";
	}

	static fromJSON(json) {
		return new StartPlatformTransferRequest(json);
	}

	toJSON() {
		return {
			sourceInstanceId: this.sourceInstanceId,
			sourcePlatformIndex: this.sourcePlatformIndex,
			targetInstanceId: this.targetInstanceId,
			forceName: this.forceName,
		};
	}

	static Response = {
		jsonSchema: {
			type: "object",
			properties: {
				success: { type: "boolean" },
				error: { type: "string" },
				transferId: { type: "string" },
				exportId: { type: "string" },
				message: { type: "string" },
			},
			required: ["success"],
		},
		fromJSON(json) {
			return json;
		},
	};
}

class InstanceListPlatformsRequest {
	static plugin = PLUGIN_NAME;
	static type = "request";
	static src = "controller";
	static dst = "instance";
	static jsonSchema = {
		type: "object",
		properties: {
			forceName: { type: "string", default: "player" },
		},
		additionalProperties: false,
	};

	constructor(json = {}) {
		this.forceName = json.forceName || "player";
	}

	static fromJSON(json) {
		return new InstanceListPlatformsRequest(json);
	}

	toJSON() {
		return {
			forceName: this.forceName,
		};
	}

	static Response = {
		jsonSchema: {
			type: "object",
			properties: {
				instanceId: { type: "integer" },
				instanceName: { type: "string" },
				forceName: { type: "string" },
				platforms: {
					type: "array",
					items: {
						type: "object",
						properties: {
							platformIndex: { type: "integer" },
							platformName: { type: "string" },
							forceName: { type: "string" },
							surfaceIndex: { type: ["integer", "null"] },
							surfaceName: { type: ["string", "null"] },
							entityCount: { type: "integer" },
							isLocked: { type: "boolean" },
							hasSpaceHub: { type: "boolean" },
							spaceLocation: { type: ["string", "null"] },
							currentTarget: { type: ["string", "null"] },
							speed: { type: "number" },
							state: { type: ["string", "null"] },
							departureTick: { type: ["number", "null"] },
							estimatedDurationTicks: { type: ["number", "null"] },
						},
						required: [
							"platformIndex",
							"platformName",
							"forceName",
							"surfaceIndex",
							"surfaceName",
							"entityCount",
							"isLocked",
							"hasSpaceHub",
						],
					},
				},
			},
			required: ["instanceId", "instanceName", "forceName", "platforms"],
		},
		fromJSON(json) {
			return json;
		},
	};
}

class ImportPlatformFromFileRequest {
	static plugin = PLUGIN_NAME;
	static type = "request";
	static src = ["controller", "instance"];
	static dst = "instance";
	static jsonSchema = {
		type: "object",
		properties: {
			filename: { type: "string" },
			platformName: { type: ["string", "null"], default: null },
			forceName: { type: "string", default: "player" },
		},
		required: ["filename"],
		additionalProperties: false,
	};

	constructor(json) {
		this.filename = json.filename;
		this.platformName = json.platformName ?? null;
		this.forceName = json.forceName || "player";
	}

	static fromJSON(json) {
		return new ImportPlatformFromFileRequest(json);
	}

	toJSON() {
		return {
			filename: this.filename,
			platformName: this.platformName,
			forceName: this.forceName,
		};
	}

	static Response = {
		jsonSchema: {
			type: "object",
			properties: {
				success: { type: "boolean" },
				error: { type: "string" },
			},
			required: ["success"],
		},
		fromJSON(json) {
			return json;
		},
	};
}

class TransferValidationEvent {
	static plugin = PLUGIN_NAME;
	static type = "event";
	static src = "instance";
	static dst = "controller";
	static jsonSchema = {
		type: "object",
		properties: {
			transferId: { type: "string" },
			platformName: { type: "string" },
			sourceInstanceId: { type: "integer" },
			success: { type: "boolean" },
			validation: {
				type: "object",
				properties: {
					itemCountMatch: { type: "boolean" },
					fluidCountMatch: { type: "boolean" },
					entityCount: { type: "integer" },
					mismatchDetails: { type: "string" },
				},
			},
			metrics: {
				type: "object",
				description: "Detailed phase metrics from Lua import",
				properties: {
					// Phase timing in game ticks
					tiles_ticks: { type: "integer" },
					entities_ticks: { type: "integer" },
					fluids_ticks: { type: "integer" },
					belts_ticks: { type: "integer" },
					state_ticks: { type: "integer" },
					validation_ticks: { type: "integer" },
					total_ticks: { type: "integer" },
					// Counts
					tiles_placed: { type: "integer" },
					entities_created: { type: "integer" },
					entities_failed: { type: "integer" },
					fluids_restored: { type: "integer" },
					belt_items_restored: { type: "integer" },
					circuits_connected: { type: "integer" },
					total_items: { type: "integer" },
					total_fluids: { type: "integer" },
				},
			},
		},
		required: ["transferId", "platformName", "sourceInstanceId", "success"],
		additionalProperties: false,
	};

	constructor(json) {
		this.transferId = json.transferId;
		this.platformName = json.platformName;
		this.sourceInstanceId = json.sourceInstanceId;
		this.success = json.success;
		this.validation = json.validation;
		this.metrics = json.metrics;
	}

	static fromJSON(json) {
		return new TransferValidationEvent(json);
	}

	toJSON() {
		return {
			transferId: this.transferId,
			platformName: this.platformName,
			sourceInstanceId: this.sourceInstanceId,
			success: this.success,
			validation: this.validation,
			metrics: this.metrics,
		};
	}
}

class DeleteSourcePlatformRequest {
	static plugin = PLUGIN_NAME;
	static type = "request";
	static src = "controller";
	static dst = "instance";
	static jsonSchema = {
		type: "object",
		properties: {
			platformIndex: { type: "integer" },
			platformName: { type: "string" },
			forceName: { type: "string", default: "player" },
		},
		required: ["platformIndex", "platformName"],
		additionalProperties: false,
	};

	constructor(json) {
		this.platformIndex = json.platformIndex;
		this.platformName = json.platformName;
		this.forceName = json.forceName || "player";
	}

	static fromJSON(json) {
		return new DeleteSourcePlatformRequest(json);
	}

	toJSON() {
		return {
			platformIndex: this.platformIndex,
			platformName: this.platformName,
			forceName: this.forceName,
		};
	}

	static Response = {
		jsonSchema: {
			type: "object",
			properties: {
				success: { type: "boolean" },
				error: { type: "string" },
			},
			required: ["success"],
		},
		fromJSON(json) {
			return json;
		},
	};
}

class UnlockSourcePlatformRequest {
	static plugin = PLUGIN_NAME;
	static type = "request";
	static src = "controller";
	static dst = "instance";
	static jsonSchema = {
		type: "object",
		properties: {
			platformName: { type: "string" },
			forceName: { type: "string", default: "player" },
		},
		required: ["platformName"],
		additionalProperties: false,
	};

	constructor(json) {
		this.platformName = json.platformName;
		this.forceName = json.forceName || "player";
	}

	static fromJSON(json) {
		return new UnlockSourcePlatformRequest(json);
	}

	toJSON() {
		return {
			platformName: this.platformName,
			forceName: this.forceName,
		};
	}

	static Response = {
		jsonSchema: {
			type: "object",
			properties: {
				success: { type: "boolean" },
				error: { type: "string" },
			},
			required: ["success"],
		},
		fromJSON(json) {
			return json;
		},
	};
}

class TransferStatusUpdate {
	static plugin = PLUGIN_NAME;
	static type = "request";
	static src = "controller";
	static dst = "instance";
	static jsonSchema = {
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

	constructor(json) {
		this.transferId = json.transferId;
		this.platformName = json.platformName;
		this.message = json.message;
		this.color = json.color || null;
	}

	static fromJSON(json) {
		return new TransferStatusUpdate(json);
	}

	toJSON() {
		return {
			transferId: this.transferId,
			platformName: this.platformName,
			message: this.message,
			color: this.color,
		};
	}

	static Response = {
		jsonSchema: {
			type: "object",
			properties: {
				success: { type: "boolean" },
				error: { type: "string" },
			},
			required: ["success"],
		},
		fromJSON(json) {
			return json;
		},
	};
}

class GetTransactionLogRequest {
	static plugin = PLUGIN_NAME;
	static type = "request";
	static src = ["controller", "instance", "control"];
	static dst = "controller";
	static permission = PERMISSIONS.VIEW_LOGS;
	static jsonSchema = {
		type: "object",
		properties: {
			transferId: { type: "string" },
		},
		required: ["transferId"],
		additionalProperties: false,
	};

	constructor(json) {
		this.transferId = json.transferId;
	}

	static fromJSON(json) {
		return new GetTransactionLogRequest(json);
	}

	toJSON() {
		return {
			transferId: this.transferId,
		};
	}

	static Response = {
		jsonSchema: {
			type: "object",
			properties: {
				success: { type: "boolean" },
				transferId: { type: "string" },
				events: { type: "array" },
				transferInfo: { type: ["object", "null"] },
				summary: { type: ["object", "null"] },
				error: { type: "string" },
			},
			required: ["success"],
		},
		fromJSON(json) {
			return json;
		},
	};
}

class PlatformStateChangedEvent {
	static plugin = PLUGIN_NAME;
	static type = "event";
	static src = "instance";
	static dst = "controller";
	static jsonSchema = {
		type: "object",
		properties: {
			instanceId: { type: "integer" },
			platformName: { type: "string" },
			forceName: { type: "string" },
		},
		required: ["instanceId", "platformName", "forceName"],
		additionalProperties: false,
	};

	constructor(json) {
		this.instanceId = json.instanceId;
		this.platformName = json.platformName;
		this.forceName = json.forceName;
	}

	static fromJSON(json) {
		return new PlatformStateChangedEvent(json);
	}

	toJSON() {
		return {
			instanceId: this.instanceId,
			platformName: this.platformName,
			forceName: this.forceName,
		};
	}
}
module.exports = {
	ExportPlatformRequest,
	PlatformExportEvent,
	ImportPlatformRequest,
	ImportPlatformFromFileRequest,
	ListExportsRequest,
	GetStoredExportRequest,
	ImportUploadedExportRequest,
	ExportPlatformForDownloadRequest,
	TransferPlatformRequest,
	StartPlatformTransferRequest,
	InstanceListPlatformsRequest,
	TransferValidationEvent,
	DeleteSourcePlatformRequest,
	UnlockSourcePlatformRequest,
	TransferStatusUpdate,
	GetPlatformTreeRequest,
	ListTransactionLogsRequest,
	GetTransactionLogRequest,
	SetSurfaceExportSubscriptionRequest,
	SurfaceExportTreeUpdateEvent,
	SurfaceExportTransferUpdateEvent,
	SurfaceExportLogUpdateEvent,
	PlatformStateChangedEvent,
	PERMISSIONS,
};
