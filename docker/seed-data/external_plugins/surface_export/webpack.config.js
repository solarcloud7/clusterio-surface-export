"use strict";
const path = require("path");
const webpack = require("webpack");
const { merge } = require("webpack-merge");

const common = require("@clusterio/web_ui/webpack.common");

module.exports = (env = {}, argv = {}) => merge(common(env, argv), {
	context: __dirname,
	entry: "./web/index.jsx",
	cache: { type: "filesystem", buildDependencies: { config: [__filename] } },
	output: {
		path: path.resolve(__dirname, "dist", "web"),
		filename: "static/[name].js",
		chunkFilename: "static/[name].js",
		clean: false,
	},
	plugins: [
		new webpack.container.ModuleFederationPlugin({
			name: "surface_export",
			library: { type: "var", name: "plugin_surface_export" },
			exposes: {
				"./": "./index.js",
				"./package.json": "./package.json",
				"./web": "./web/index.jsx",
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
