"use strict";

const PLUGIN_NAME = "surface_export";
const PERMISSIONS = {
	LIST_EXPORTS: `${PLUGIN_NAME}.exports.list`,
	TRANSFER_EXPORTS: `${PLUGIN_NAME}.exports.transfer`,
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
		},
		required: ["platformIndex"],
		additionalProperties: false,
	};

	constructor(json) {
		this.platformIndex = json.platformIndex;
		this.forceName = json.forceName || "player";
	}

	static fromJSON(json) {
		return new ExportPlatformRequest(json);
	}

	toJSON() {
		return {
			platformIndex: this.platformIndex,
			forceName: this.forceName,
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
			additionalProperties: false,
		},
		fromJSON(json) {
			return json;
		},
	};
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
			additionalProperties: false,
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
				additionalProperties: false,
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
			additionalProperties: false,
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
			additionalProperties: false,
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
			additionalProperties: false,
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
			additionalProperties: false,
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
			additionalProperties: false,
		},
		fromJSON(json) {
			return json;
		},
	};
}

class GetTransactionLogRequest {
	static plugin = PLUGIN_NAME;
	static type = "request";
	static src = ["controller", "instance"];
	static dst = "controller";
	static permission = PERMISSIONS.LIST_EXPORTS;
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
				transferInfo: { type: "object" },
				error: { type: "string" },
			},
			required: ["success"],
			additionalProperties: false,
		},
		fromJSON(json) {
			return json;
		},
	};
}

module.exports = {
	ExportPlatformRequest,
	PlatformExportEvent,
	ImportPlatformRequest,
	ImportPlatformFromFileRequest,
	ListExportsRequest,
	TransferPlatformRequest,
	TransferValidationEvent,
	DeleteSourcePlatformRequest,
	UnlockSourcePlatformRequest,
	TransferStatusUpdate,
	GetTransactionLogRequest,
	PERMISSIONS,
};
