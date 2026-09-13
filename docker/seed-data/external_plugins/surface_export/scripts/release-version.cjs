"use strict";

function releaseChannel(version) {
	if (typeof version !== "string") throw new Error("unsupported release version");
	const match = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(alpha|beta|rc)\.(?:0|[1-9]\d*))?$/.exec(version);
	if (!match || match[0] !== version) {
		throw new Error("unsupported release version; use a stable version or alpha.N, beta.N, rc.N");
	}
	return match[1] ?? "latest";
}

module.exports = { releaseChannel };
