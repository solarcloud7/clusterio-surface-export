"use strict";


const tseslint = require("typescript-eslint");

const LINK_METHODS = "handle|handleRequest|handleEvent|sendTo|send|sendRequest|sendEvent|subscribe";

module.exports = tseslint.config(
	{
		ignores: ["dist/**", "node_modules/**", "**/*.js", "**/*.d.ts", "scripts/vendor/**"],
	},
	{
		files: ["**/*.ts", "**/*.tsx"],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				project: ["./tsconfig.node.json", "./tsconfig.browser.json"],
				tsconfigRootDir: __dirname,
			},
		},
		plugins: { "@typescript-eslint": tseslint.plugin },
		rules: {
			"@typescript-eslint/unbound-method": ["error", { ignoreStatic: true }],

			"no-empty": ["error", { allowEmptyCatch: false }],

			"no-restricted-syntax": [
				"error",
				{
					selector: `TSAsExpression > MemberExpression[property.name=/^(${LINK_METHODS})$/]`,
					message:
						"Do not cast a Clusterio Link method as a value (e.g. `this.i.sendTo as (...)`). " +
						"The cast loses `this` -> runtime crash ('reading sendRequest'/'handleRequest'). " +
						"Call it BOUND (`this.i.sendTo(...)`) and cast the ARGS/result instead. See CLAUDE.md: never extract a Clusterio Link method — call it bound.",
				},
				{
					selector: `VariableDeclarator > MemberExpression.init[property.name=/^(${LINK_METHODS})$/]`,
					message:
						"Do not assign a Clusterio Link method to a variable (e.g. `const h = this.i.handle`). " +
						"Extracting it loses `this` -> runtime crash. Call it BOUND. See CLAUDE.md: never extract a Clusterio Link method — call it bound.",
				},
				{
					selector: "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression[body.type='BlockStatement'][body.body.length=0]",
					message:
						"Empty `.catch(() => {})` silently swallows a promise rejection. Log/handle/rethrow it " +
						"(a stray swallow has hidden real bugs here — see the pcall/catch audit).",
				},
			],
		},
	},
);
