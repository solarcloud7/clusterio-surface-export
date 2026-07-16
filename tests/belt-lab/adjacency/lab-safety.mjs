export function requireLuaSuccess(result, operation) {
	if (result?.success !== true) {
		throw new Error(`${operation} failed: ${result?.error || "missing success=true"}`);
	}
	return result;
}
