"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const scriptUrl = pathToFileURL(path.join(__dirname, "..", "scripts", "lint-catch-swallow.mjs")).href;

async function scan(source) {
	const { findCatchSwallows } = await import(scriptUrl);
	return findCatchSwallows(source, "fixture.ts");
}

test("catch-swallow guard flags fallback assignment with and without a binding", async () => {
	assert.equal((await scan("try { read(); } catch (err) { allLogs = []; }" )).length, 1);
	assert.equal((await scan("try { read(); } catch { allLogs = []; }" )).length, 1);
});

test("catch-swallow guard requires the caught binding to reach the sink", async () => {
	assert.equal((await scan("try { read(); } catch (err) { logger.error('failed'); }" )).length, 1);
	assert.equal((await scan("try { read(); } catch (err) { logger.error('failed', err); }" )).length, 0);
});

test("catch-swallow guard accepts throw, rejection, returned errors, and user-visible errors", async () => {
	const source = `
		try { a(); } catch (err) { throw new Error("failed", { cause: err }); }
		try { b(); } catch (err) { reject(err); }
		try { c(); } catch (err) { return { error: getErrorMessage(err) }; }
		try { d(); } catch (err) { antMessage.error(getErrorMessage(err)); }
	`;
	assert.deepEqual(await scan(source), []);
});

test("catch-swallow guard accepts escape-by-assignment and .push sinks (SC-70 .mjs surface)", async () => {
	// Outer-variable retry pattern: lastError is declared ABOVE the catch and rethrown after the loop.
	assert.deepEqual(await scan("let lastError; try { a(); } catch (error) { lastError = error; }"), []);
	// Property write into an object the caller reads.
	assert.deepEqual(await scan("try { a(); } catch (error) { outcome.error = error.message; }"), []);
	// Push into an outer findings collection.
	assert.deepEqual(await scan("try { a(); } catch (error) { leftovers.push(`gone: ${error.message}`); }"), []);
	// Still swallows: assignment whose right side never mentions the binding.
	assert.equal((await scan("try { a(); } catch (error) { allLogs = []; }")).length, 1);
	// Still swallows: the error only reaches a variable declared INSIDE the body.
	assert.equal((await scan("try { a(); } catch (error) { const msg = error.message; }")).length, 1);
	// Still swallows: push without the binding in its arguments.
	assert.equal((await scan("try { a(); } catch (error) { items.push('failed'); }")).length, 1);
});

test("catch-swallow guard honors catch:allow only on the catch line or line above", async () => {
	const allowed = `
		try { a(); }
		// catch:allow owner-approved probe
		catch (err) { fallback = []; }
		try { b(); } catch (err) { fallback = []; } // catch:allow owner-approved probe
	`;
	assert.deepEqual(await scan(allowed), []);

	const tooFar = `
		// catch:allow too far away
		const marker = true;
		try { a(); } catch (err) { fallback = []; }
	`;
	assert.equal((await scan(tooFar)).length, 1);
});

test("catch-swallow guard ignores catch text and braces inside comments and strings", async () => {
	const source = `
		const sample = "catch (err) { fallback = []; }";
		// catch (err) { fallback = []; }
		try { a(); } catch (err) {
			logger.error(\`failed with brace } and ${"${getErrorMessage(err)}"}\`);
		}
	`;
	assert.deepEqual(await scan(source), []);
});
