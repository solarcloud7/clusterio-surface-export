import type { ActiveTransfer, OperationOptions, OperationType } from "../messages";
import { generateOperationId } from "../helpers";

export function createOperationRecord(
	operationType: OperationType,
	options: OperationOptions & { resolveInstanceName?: (instanceId: number) => string | null } = {},
): ActiveTransfer {
	const resolveInstanceName = options.resolveInstanceName ?? (() => null);
	const sourceInstanceId = Number.isInteger(Number(options.sourceInstanceId))
		? Number(options.sourceInstanceId)
		: -1;
	const targetInstanceId = Number.isInteger(Number(options.targetInstanceId))
		? Number(options.targetInstanceId)
		: -1;
	const operationId = String(options.operationId || generateOperationId(operationType));
	const sourceInstanceName = options.sourceInstanceName
		?? (sourceInstanceId > 0 ? resolveInstanceName(sourceInstanceId) : null);
	const targetInstanceName = options.targetInstanceName
		?? (targetInstanceId > 0 ? resolveInstanceName(targetInstanceId) : null);
	const candidatePlatformIndex = Number(options.platformIndex);
	const platformIndex = Number.isInteger(candidatePlatformIndex) && candidatePlatformIndex > 0
		? candidatePlatformIndex
		: null;
	if (operationType === "transfer" && platformIndex === null) {
		throw new Error("platformIndex is required for transfer operations");
	}
	const operation: ActiveTransfer = {
		transferId: operationId,
		operationType,
		exportId: options.exportId || null,
		sourceExportId: options.sourceExportId || null,
		artifactSizeBytes: options.artifactSizeBytes ?? null,
		platformName: options.platformName || "Unknown",
		platformIndex: platformIndex ?? 1,
		forceName: options.forceName || "player",
		sourceInstanceId,
		sourceInstanceName,
		targetInstanceId,
		targetInstanceName,
		status: options.status || "in_progress",
		startedAt: options.startedAt || Date.now(),
		completedAt: options.completedAt || null,
		failedAt: options.failedAt || null,
		error: options.error || null,
	};
	return operation;
}
