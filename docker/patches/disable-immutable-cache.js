// DEV-ONLY static-cache patch for the local Clusterio dev cluster.
//
// The controller serves everything under /static with `Cache-Control: immutable, max-age=1y`
// (@clusterio/controller Controller.js). `immutable` is only safe for content-hashed filenames,
// but the surface_export plugin's webpack emits FIXED chunk names (static/[name].js) and the
// Module-Federation entry/manifest are fixed by necessity. Result: the browser pins stale chunks
// for a year, so every `npm run build:web` needs a manual hard-refresh — and returning prod users
// would get stale chunks after an update.
//
// This idempotent patch flips the dev cluster to revalidate (max-age=0) so web rebuilds show up
// without a hard refresh. It is run at controller startup via the entrypoint wrapper in
// docker-compose.yml, BEFORE `clusteriocontroller run` loads Controller.js. Re-applies after image
// pulls/recreates; safe no-op if already applied or if the upstream pattern changes.
//
// This is a DEV convenience, not the real fix. The persistent fix is: content-hash the plugin's
// chunk filenames in webpack.config.js AND serve the MF entry/manifest with `no-cache` (a Clusterio
// core change). Until then, this keeps local iteration friction-free.
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
