// Sanitize before truncating: cutting a secret first can leave a recognizable prefix.
export function redactDiagnostic(value) {
	return String(value)
		.replace(/\\+"/g, '"')
		.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
		.replace(/((?:x-access-token|authorization|controller_token|password|token)\s*["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)/gi, "$1[REDACTED]");
}

export function diagnosticLine(raw, maxChars = 800) {
	let text = String(raw);
	try {
		const record = JSON.parse(text);
		if (record && typeof record === "object" && !Array.isArray(record)) {
			text = [record.timestamp, record.level, record.plugin, record.instance_id, record.transferId,
				record.stage, record.message].filter(value => value !== undefined).join(" ");
		}
	} catch (error) {
		// Engine output is plain text; only a JSON syntax mismatch takes the text fallback.
		if (!(error instanceof SyntaxError)) throw error;
	}
	return redactDiagnostic(text).replace(/[\r\n]+/g, " ").slice(0, maxChars);
}
