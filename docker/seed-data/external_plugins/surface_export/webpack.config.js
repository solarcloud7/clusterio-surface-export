"use strict";
const path = require("path");
const webpack = require("webpack");
const { merge } = require("webpack-merge");

function resolveClusterioWebpackCommon() {
	const candidates = [
		"@clusterio/web_ui/webpack.common",
		path.resolve(__dirname, "../../../../clusterio/packages/web_ui/webpack.common.js"),
		path.resolve(__dirname, "../../../../clusterio/packages/web_ui/webpack.common"),
	];

	for (const candidate of candidates) {
		try {
			return require(candidate);
		} catch (_err) {
			// Try the next candidate.
		}
	}

	throw new Error("Unable to resolve Clusterio webpack.common (tried package and local workspace fallback)");
}

const common = resolveClusterioWebpackCommon();

module.exports = (env = {}, argv = {}) => merge(common(env, argv), {
	context: __dirname,
	entry: "./web/index.tsx",
	cache: { type: "filesystem", buildDependencies: { config: [__filename] } },
	resolve: {
		extensions: [".tsx", ".ts", ".jsx", ".js"],
	},
	output: {
		path: path.resolve(__dirname, "dist", "web"),
		// Content-hash every emitted chunk so the controller's immutable 1y /static cache header is
		// actually correct: a content change yields a NEW url, so returning users can never serve a
		// stale chunk. The Module-Federation remote entry is resolved via dist/web/manifest.json
		// (shipped through /api/plugins — NOT the immutable /static cache), so the entry is safe to
		// hash too. This restores @clusterio/web_ui's default; the prior fixed "static/[name].js"
		// override silently defeated it (see the "Web cache" guard entry in CLAUDE.md).
		filename: "static/[name].[contenthash].js",
		chunkFilename: "static/[name].[contenthash].js",
		clean: false, // safe: @clusterio/web_ui's CleanWebpackPlugin clears old hashes each build (no stale-file buildup)
	},
	plugins: [
		new webpack.container.ModuleFederationPlugin({
			name: "surface_export",
			library: { type: "var", name: "plugin_surface_export" },
			exposes: {
				"./": "./index.ts",
				"./package.json": "./package.json",
				"./web": "./web/index.tsx",
			},
			shared: {
				"@clusterio/lib": { import: false },
				"@clusterio/web_ui": { import: false },
				"antd": { import: false },
				"react": { import: false },
				"react-dom": { import: false },
			},
		}),
	],
});
