import { RequestError } from "@clusterio/lib";

export function isInstanceRouteRejection(error: unknown): boolean {
	return error instanceof RequestError && (
		["Host containing instance is not connected", "Instance is not assigned to a host", "Instance is not running."].includes(error.message)
		|| /^Instance (?:with ID )?\d+ does not exist$/.test(error.message)
		|| /^Instance \d+ is not assigned a host$/.test(error.message)
		|| /^Assigned host for instance \d+ is offline$/.test(error.message));
}
