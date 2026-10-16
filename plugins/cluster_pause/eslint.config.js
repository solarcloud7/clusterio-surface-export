import tseslint from "typescript-eslint";

const LINK_METHODS = "handle|handleRequest|handleEvent|sendTo|send|sendRequest|sendEvent|subscribe";

export default tseslint.config(
	{
		ignores: ["dist/**", "node_modules/**", "**/*.js", "**/*.cjs", "**/*.d.ts"],
	},
	{
		files: ["**/*.ts"],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				project: ["./tsconfig.node.json"],
				tsconfigRootDir: import.meta.dirname,
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
					message: "Do not cast a Clusterio Link method as a value; call it bound and cast the arguments or result instead.",
				},
				{
					selector: `VariableDeclarator > MemberExpression.init[property.name=/^(${LINK_METHODS})$/]`,
					message: "Do not assign a Clusterio Link method to a variable; call it bound.",
				},
				{
					selector: "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression[body.type='BlockStatement'][body.body.length=0]",
					message: "Empty `.catch(() => {})` silently swallows a promise rejection. Log, handle or rethrow it.",
				},
			],
		},
	},
);
