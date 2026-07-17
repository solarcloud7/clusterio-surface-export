export function requireLuaSuccess(result, instance) {
	if (result?.success !== true) {
		throw new Error(`${instance} Lua command failed: ${result?.error || "missing success=true"}`);
	}
	return result;
}
