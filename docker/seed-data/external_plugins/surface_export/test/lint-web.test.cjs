"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { ESLint } = require("eslint");

const pluginRoot = path.resolve(__dirname, "..");
const eslint = new ESLint({
	cwd: pluginRoot,
	overrideConfig: {
		languageOptions: { parserOptions: { disallowAutomaticSingleRunInference: true } },
	},
});

for (const file of ["web/view-models.ts", "web/TransactionLogsTab.tsx"]) {
	test(`frontend correctness guards reject unsafe code in ${file}`, async () => {
		const source = `
class Transport { send() { return this; } }
const transport = new Transport();
const send = transport.send;
try { send(); } catch (error) {}
export { send };
`;
		const [result] = await eslint.lintText(source, { filePath: path.join(pluginRoot, file) });
		assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
		const rules = new Set(result.messages.map(message => message.ruleId));
		assert.ok(rules.has("@typescript-eslint/unbound-method"), JSON.stringify(result.messages));
		assert.ok(rules.has("no-restricted-syntax"), JSON.stringify(result.messages));
		assert.ok(rules.has("no-empty"), JSON.stringify(result.messages));
	});
}

test("frontend lint accepts bound calls, surfaced errors, and JSX", async () => {
	const source = `
class Transport { send() { return this; } }
const transport = new Transport();
function send() {
 try { transport.send(); } catch (error) { console.error(error); }
}
export const Button = () => <button onClick={send}>Send</button>;
`;
	const [result] = await eslint.lintText(source, {
		filePath: path.join(pluginRoot, "web/TransactionLogsTab.tsx"),
	});
	assert.deepEqual(result.messages, []);
});
