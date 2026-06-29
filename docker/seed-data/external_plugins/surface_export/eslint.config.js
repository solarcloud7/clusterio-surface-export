"use strict";

/*
 * ESLint flat config (type-aware) for the surface_export plugin's Node TypeScript.
 *
 * Primary purpose: mechanically guard the Clusterio Link-method binding footgun that
 * caused TWO production crashes (CLAUDE.md Pitfall #26). PR #2 introduced
 *   const handleMessage = this.i.handle as (...) => void;   // crashed instance START
 *   const sendToController = this.i.sendTo as (...) => ...;  // crashed the TRANSFER
 * Extracting/casting a Link method as a value loses `this`, so it runs with
 * `this === undefined` and throws inside @clusterio/lib ("reading 'handleRequest'"/
 * "reading 'sendRequest'"). A manual audit caught `handle` but MISSED `sendTo` — which is
 * exactly why this must be enforced by a rule, not review.
 */

const tseslint = require("typescript-eslint");

// Clusterio Link methods that MUST be invoked bound — never extracted or cast as a value.
const LINK_METHODS = "handle|handleRequest|handleEvent|sendTo|send|sendRequest|sendEvent|subscribe";

module.exports = tseslint.config(
	{
		ignores: ["dist/**", "node_modules/**", "web/**", "**/*.js", "**/*.d.ts"],
	},
	{
		files: ["**/*.ts"],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				project: ["./tsconfig.node.json"],
				tsconfigRootDir: __dirname,
			},
		},
		plugins: { "@typescript-eslint": tseslint.plugin },
		rules: {
			// Catches `const m = obj.method; m()` on a PROPERLY-TYPED receiver. NOTE: our footgun
			// site uses an `any`-typed getter (`this.i`/`this.c`), so unbound-method does NOT fire
			// there — the no-restricted-syntax selectors below are the actual guard. Kept because it
			// still adds value if a typed receiver is introduced.
			"@typescript-eslint/unbound-method": ["error", { ignoreStatic: true }],

			// THE actual guard. Backstop for the forms `unbound-method` misses (cast suppresses it,
			// and `any` receivers defeat type-aware analysis):
			//   (1) `this.i.sendTo as (...) => ...`   — casting the method as a value
			//   (2) `const h = this.i.handle`          — assigning the method to a variable
			// A BOUND call `this.i.sendTo(...)` is a CallExpression and is NOT matched.
			// An ARG/result cast `... as never` / `new Msg(...) as never` is NOT matched
			// (the cast target is not a Link-method MemberExpression).
			// A truly-empty catch silently swallows an error (a comment-only catch is allowed for a
			// deliberate, explained no-op). Mirrors the Lua pcall-discipline guard — silent failures
			// have repeatedly hidden real bugs here. See the pcall/catch audit.
			"no-empty": ["error", { allowEmptyCatch: false }],

			"no-restricted-syntax": [
				"error",
				{
					selector: `TSAsExpression > MemberExpression[property.name=/^(${LINK_METHODS})$/]`,
					message:
						"Do not cast a Clusterio Link method as a value (e.g. `this.i.sendTo as (...)`). " +
						"The cast loses `this` -> runtime crash ('reading sendRequest'/'handleRequest'). " +
						"Call it BOUND (`this.i.sendTo(...)`) and cast the ARGS/result instead. See CLAUDE.md Pitfall #26.",
				},
				{
					selector: `VariableDeclarator > MemberExpression.init[property.name=/^(${LINK_METHODS})$/]`,
					message:
						"Do not assign a Clusterio Link method to a variable (e.g. `const h = this.i.handle`). " +
						"Extracting it loses `this` -> runtime crash. Call it BOUND. See CLAUDE.md Pitfall #26.",
				},
				{
					// `.catch(() => {})` / `.catch((e) => {})` with an empty body silently swallows a promise
					// rejection. Log it, handle it, or rethrow. (A non-empty handler is fine.)
					selector: "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression[body.type='BlockStatement'][body.body.length=0]",
					message:
						"Empty `.catch(() => {})` silently swallows a promise rejection. Log/handle/rethrow it " +
						"(a stray swallow has hidden real bugs here — see the pcall/catch audit).",
				},
			],
		},
	},
);
