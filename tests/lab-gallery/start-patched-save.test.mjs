import assert from "node:assert/strict";
import test from "node:test";
import { startPatchedSave } from "./start-patched-save.mjs";

const migration = "clusterio_private.update_instance: attempt to index global 'clusterio_private' (a nil value)";
for (const [name, errors, status, starts, throws] of [
	["successful start", [], "stopped", 1, false],
	["persisted scenario migration", [migration], "stopped", 2, false],
	["repeated migration failure", [migration, migration], "stopped", 2, true],
	["unrelated startup failure", ["invalid mod"], "stopped", 1, true],
	["unconfirmed stop", [migration], "starting", 1, true],
	["missing instance", [migration], null, 1, true],
]) {
	test(name, () => {
		const calls = [];
		const ctl = (...args) => {
			calls.push(args);
			if (args[1] === "list") return status ? `fixture | 1 | 1 | 34100 | ${status}` : "";
			const error = errors[calls.filter(call => call[1] === "start").length - 1];
			if (error) throw new Error(error);
			return "started";
		};
		if (throws) {
			assert.throws(() => startPatchedSave(ctl, "fixture", "checkpoint.zip"));
		} else {
			assert.equal(startPatchedSave(ctl, "fixture", "checkpoint.zip"), "started");
		}
		assert.deepEqual(calls.filter(call => call[1] === "start"),
			Array.from({ length: starts }, () => ["instance", "start", "fixture", "--save", "checkpoint.zip"]));
	});
}
