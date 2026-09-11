function redactText(value) {
	return String(value)
		.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
		.replace(/((?:x-access-token|authorization|controller_token|password|token)\\*["']?\s*[:=]\s*)(\\+")(.*?)\2/gi,
			"$1$2[REDACTED]$2")
		.replace(/((?:x-access-token|authorization|controller_token|password|token)\s*["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)/gi,
			(_match, prefix, secret) => prefix + (secret.startsWith('"') ? '"[REDACTED]"' : secret.startsWith("'") ? "'[REDACTED]'" : "[REDACTED]"));
}

export function redactDiagnostic(value) {
	const text = String(value);
	let parsed;
	try { parsed = JSON.parse(text); }
	catch (error) { if (error instanceof SyntaxError) return redactText(text); throw error; }
	const visit = item => {
		if (typeof item === "string") return redactText(item);
		if (Array.isArray(item)) return item.map(visit);
		if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, entry]) =>
			[key, /(?:token|password|authorization)$/i.test(key) ? "[REDACTED]" : visit(entry)]));
		return item;
	};
	return JSON.stringify(visit(parsed));
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
