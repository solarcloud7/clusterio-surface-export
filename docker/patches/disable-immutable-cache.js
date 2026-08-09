"use strict";
const fs = require("fs");

const target = "/clusterio/node_modules/@clusterio/controller/dist/node/src/Controller.js";
const from = "{ immutable: true, maxAge: 1000 * 86400 * 365 }";
const to = "{ immutable: false, maxAge: 0 }";

try {
	const src = fs.readFileSync(target, "utf8");
	if (src.includes(to)) {
		console.log("[dev-cache-patch] already applied — static assets revalidate (max-age=0)");
	} else if (src.includes(from)) {
		fs.writeFileSync(target, src.replace(from, to));
		console.log("[dev-cache-patch] applied — static assets now revalidate (was immutable 1y)");
	} else {
		console.log("[dev-cache-patch] WARNING: expected cache pattern not found in Controller.js "
			+ "(Clusterio version changed?). Skipping — controller starts normally.");
	}
} catch (err) {
	console.log("[dev-cache-patch] non-fatal: could not patch Controller.js:", err && err.message);
}
