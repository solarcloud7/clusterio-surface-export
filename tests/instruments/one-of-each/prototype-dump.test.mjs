// prototype-dump.test — the committed universe.json still derives from the dump it was read from
//
// requires: prototype-dump.json and prototype-dump.provenance.json committed beside
//           derive-universe.mjs, the reviewed residue the derivation consumes, and universe.json
// produces: a byte-identical re-derivation of universe.json from the vendored dump (so an edit to
//           either side fails here rather than drifting), an independent sha256 of the vendored
//           bytes against the provenance pin, and mutation-kill evidence for both
// does not: contact any instance, re-dump anything, claim the vendored dump describes any pin other
//           than the one it records, or check that a rolling-stock or rail type list still
//           ENUMERATES its subclass — the dump carries no per-prototype subclass, so a type ADDED
//           at a future pin is not caught here (see does_not_carry / remedy_at_next_redump in the
//           provenance); the row_fields comparison is a UNION over every row, so a field that goes
//           CONDITIONAL in a re-dump is invisible to it — only a field added or removed everywhere
//           trips it

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	DUMP_PATH, PROVENANCE_PATH, assemble, checkControls, checkRailTaxonomy, loadVendoredDump, readDump,
	serializeArtifact,
} from "./derive-universe.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const UNIVERSE_PATH = path.join(here, "universe.json");

const provenance = JSON.parse(readFileSync(PROVENANCE_PATH, "utf8"));
const dumpBytes = readFileSync(DUMP_PATH);
const dump = loadVendoredDump();

const reviewed = {
	ephemeraRaw: JSON.parse(readFileSync(path.join(here, "ephemera-exclusions.json"), "utf8")),
	bonusRaw: JSON.parse(readFileSync(path.join(here, "bonus-inclusions.json"), "utf8")),
	annexRaw: JSON.parse(readFileSync(path.join(here, "transient-annex.json"), "utf8")),
};

function vendorPair(dumpValue) {
	const dir = mkdtempSync(path.join(tmpdir(), "one-of-each-dump-"));
	const dumpPath = path.join(dir, "prototype-dump.json");
	const bytes = Buffer.from(JSON.stringify(dumpValue));
	writeFileSync(dumpPath, bytes);
	const provenancePath = path.join(dir, "prototype-dump.provenance.json");
	writeFileSync(provenancePath, JSON.stringify({
		...provenance,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		bytes: bytes.length,
	}));
	return { dir, dumpPath, provenancePath };
}

test("the vendored dump is the bytes an instance produced, pinned by its own provenance", () => {
	assert.equal(createHash("sha256").update(dumpBytes).digest("hex"), provenance.sha256);
	assert.equal(dumpBytes.length, provenance.bytes);
	assert.equal(dump.version, provenance.pin);
	assert.ok(dump.rows.length > 1000, "a dump this short is not the whole prototype set");
	assert.ok(Object.keys(dump.props).length > 0, "without a property vector no surface condition can be judged");
});

test("the committed universe.json re-derives byte-identical from the vendored dump", () => {
	const artifact = assemble({ dump, ...reviewed });
	assert.deepEqual(checkControls(artifact), []);
	assert.ok(Buffer.from(serializeArtifact(artifact)).equals(readFileSync(UNIVERSE_PATH)),
		"universe.json is not what the derivation produces from the vendored dump — rerun derive-universe.mjs");
});

test("MUTATION KILL: a universe.json that no longer matches the dump goes red, and no control catches it", () => {
	const stale = JSON.parse(JSON.stringify(dump));
	const dropped = stale.rows.findIndex(row => row.n === "wooden-chest");
	assert.notEqual(dropped, -1, "the mutation must remove a prototype that is actually there");
	stale.rows.splice(dropped, 1);
	const artifact = assemble({ dump: stale, ...reviewed });
	assert.deepEqual(checkControls(artifact), [],
		"this mutation is chosen because the counts controls stay green — the byte comparison is the only teeth");
	assert.ok(!Buffer.from(serializeArtifact(artifact)).equals(readFileSync(UNIVERSE_PATH)),
		"a dump change that survives every control must still turn the byte comparison red");
});

test("MUTATION KILL: an edited vendored dump is refused by the sha256 pin", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "one-of-each-dump-"));
	try {
		const edited = Buffer.from(dumpBytes);
		edited[edited.length - 2] = edited[edited.length - 2] === 0x30 ? 0x31 : 0x30;
		const editedPath = path.join(dir, "prototype-dump.json");
		writeFileSync(editedPath, edited);
		assert.equal(edited.length, provenance.bytes, "a one-byte edit must be caught by the hash, not the length");
		assert.throws(() => loadVendoredDump(editedPath, PROVENANCE_PATH), /sha256/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a dump recording a prototype that threw is refused — an empty Lua table is not an error list", () => {
	const clean = vendorPair({ ...dump, errs: {} });
	try {
		assert.equal(loadVendoredDump(clean.dumpPath, clean.provenancePath).rows.length, dump.rows.length,
			"errs as an EMPTY Lua table is the normal case and must load");
	} finally {
		rmSync(clean.dir, { recursive: true, force: true });
	}

	const thrown = vendorPair({ ...dump, errs: { 1: { n: "some-prototype", e: "attempt to index nil" } } });
	try {
		assert.throws(() => loadVendoredDump(thrown.dumpPath, thrown.provenancePath),
			/records 1 prototype\(s\) that threw/,
			"a Lua-table errs list has no .length — reading it as an array would pass this dump forever");
	} finally {
		rmSync(thrown.dir, { recursive: true, force: true });
	}
});

test("a vendored dump from another pin than its provenance claims is refused", () => {
	const repinned = vendorPair({ ...dump, version: "9.9.9" });
	try {
		assert.throws(() => loadVendoredDump(repinned.dumpPath, repinned.provenancePath),
			/dumped at 9\.9\.9 but its provenance claims pin/);
	} finally {
		rmSync(repinned.dir, { recursive: true, force: true });
	}
});

test("the dump carries no per-prototype subclass, and the provenance says so with its remedy", () => {
	const fields = [...new Set(dump.rows.flatMap(row => Object.keys(row)))].sort();
	assert.deepEqual(fields, [...provenance.row_fields].sort(),
		"the dump's row fields moved — if a re-dump now carries a subclass discriminator, replace the hardcoded "
		+ "rolling-stock and rail type lists with an agreement check against it (remedy_at_next_redump)");
	assert.ok(provenance.does_not_carry.includes("subclass"));
	assert.ok(provenance.remedy_at_next_redump.length > 20);
});

test("the derivation reads the vendored dump by default and refuses live-only flags without --live", () => {
	assert.equal(JSON.stringify(readDump([])), JSON.stringify(dump));
	assert.equal(JSON.stringify(readDump(["--dump", DUMP_PATH])), JSON.stringify(dump));
	for (const flag of ["--instance", "--platform", "--host"]) {
		assert.throws(() => readDump([flag, "whatever"]), /pass --live/,
			`${flag} without --live must refuse rather than silently derive from the vendored dump`);
	}
});

test("--dump refuses every live-only flag too — the captured path ignores them all the same", () => {
	for (const flag of ["--live", "--instance", "--platform", "--host"]) {
		assert.throws(() => readDump(["--dump", DUMP_PATH, flag, "whatever"]), /--dump reads a captured one/,
			`${flag} beside --dump must refuse rather than be silently ignored`);
	}
});

test("the vendored dump still carries every rolling-stock and rail type the derivation hardcodes", () => {
	assert.equal(checkRailTaxonomy(dump.rows), undefined,
		"the taxonomy control only runs in main() today, so a renamed type would reach no test");
	assert.throws(() => checkRailTaxonomy(dump.rows.filter(row => row.t !== "straight-rail")),
		/\[straight-rail\] are named as rolling stock or rail but do not exist/,
		"the sha256 pin makes a rail-less dump unreachable on disk, so the teeth are proven on filtered real rows");
});
