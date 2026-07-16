export function requireLuaSuccess(result, operation) {
	if (result?.success !== true) {
		throw new Error(`${operation} failed: ${result?.error || "missing success=true"}`);
	}
	return result;
}

export function preflight(instances, inspect) {
	const states = {};
	for (const instance of instances) {
		const state = requireLuaSuccess(inspect(instance), `preflight:${instance}`);
		states[instance] = state;
		for (const field of ["gamePaused", "jobs", "locks", "holds", "tombstones"]) {
			if (state[field]) throw new Error(`${instance} preflight blocked by ${field}: ${JSON.stringify(state)}`);
		}
	}
	return states;
}

export function cleanupAll(instances, cleanup, inspect) {
	const results = {};
	for (const instance of instances) {
		const result = { cleanup: null, inspection: null, errors: [] };
		results[instance] = result;
		try {
			result.cleanup = requireLuaSuccess(cleanup(instance), `cleanup:${instance}`);
		} catch (error) {
			result.errors.push(error.stack || error.message);
		}
		try {
			result.inspection = requireLuaSuccess(inspect(instance), `cleanup-inspect:${instance}`);
		} catch (error) {
			result.errors.push(error.stack || error.message);
		}
	}
	return results;
}
