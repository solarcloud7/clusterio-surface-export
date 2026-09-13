type OperationState = { status: string; timingPendingRecovery?: boolean | null };

export function isSourceJobPending(status: string): boolean {
	return status === "in_progress" || status === "preparing";
}

export function isDestinationJobPending(status: string): boolean {
	return status === "awaiting_validation" || status === "awaiting_completion";
}

export function isJobObservationPending(status: string): boolean {
	return isSourceJobPending(status) || isDestinationJobPending(status);
}

export function hasRecordedOutcome(status: string): boolean {
	return ["completed", "failed", "error", "cleanup_failed"].includes(status);
}

export function isAdmissionSettled(operation: OperationState): boolean {
	return hasRecordedOutcome(operation.status) && !operation.timingPendingRecovery;
}

export function hasUnresolvedPlatformOwnership(operation: OperationState): boolean {
	return operation.status !== "queued" && (Boolean(operation.timingPendingRecovery)
		|| !["completed", "failed", "error"].includes(operation.status));
}
