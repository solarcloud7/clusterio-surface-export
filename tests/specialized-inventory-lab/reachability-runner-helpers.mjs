export function requireLuaSuccess(result, instance) {
	if (result?.success !== true) {
		throw new Error(`${instance} Lua command failed: ${result?.error || "missing success=true"}`);
	}
	return result;
}

export function runCleanupBoth(instances, operations) {
	const cleanup = {};
	for (const instance of instances) {
		const entry = { action: null, zero: null, errors: [] };
		cleanup[instance] = entry;
		try {
			entry.action = operations.action(instance);
		} catch (error) {
			entry.errors.push(error.stack || error.message);
		}
		try {
			entry.zero = operations.inspect(instance);
		} catch (error) {
			entry.errors.push(error.stack || error.message);
		}
	}
	return cleanup;
}

export function assertSafeToMutate(preflight) {
	for (const [instance, result] of Object.entries(preflight)) {
		if (result.errors?.length) {
			throw new Error(`${instance} preflight failed: ${result.errors.join("; ")}`);
		}
		const zero = result.zero;
		for (const field of [
			"game_paused",
			"destination_holds",
			"locked_platforms",
			"async_jobs",
			"committed_source_tombstones",
		]) {
			if (zero?.[field]) throw new Error(`${instance} preflight blocked by ${field}: ${JSON.stringify(zero)}`);
		}
	}
}
