import assert from "node:assert/strict";
import test from "node:test";
import { startPatchedSave } from "./start-patched-save.mjs";

const migration = "clusterio_private.update_instance: attempt to index global 'clusterio_private' (a nil value)";
for (const [name, errors, status, starts] of [
	["successful start", [], "stopped", 1],
	["persisted scenario migration", [migration], "stopped", 2],
	["repeated migration failure", [migration, migration], "stopped", 2],
	["unrelated startup failure", ["invalid mod"], "stopped", 1],
	["unconfirmed stop", [migration], "starting", 1],
	["missing instance", [migration], null, 1],
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
		if (errors.length && !(errors.length === 1 && errors[0] === migration && status === "stopped")) {
			assert.throws(() => startPatchedSave(ctl, "fixture", "checkpoint.zip"));
		} else {
			assert.equal(startPatchedSave(ctl, "fixture", "checkpoint.zip"), "started");
		}
		assert.deepEqual(calls.filter(call => call[1] === "start"),
			Array.from({ length: starts }, () => ["instance", "start", "fixture", "--save", "checkpoint.zip"]));
	});
}
