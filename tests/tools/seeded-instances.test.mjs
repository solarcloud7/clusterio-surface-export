import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { seededHosts, seededInstanceNames, seededInstances } from "../../tools/shared/seeded-instances.mjs";

function tree(spec) {
	const root = mkdtempSync(join(tmpdir(), "seeded-instances-"));
	for (const [host, instances] of Object.entries(spec)) {
		for (const [instance, saves] of Object.entries(instances)) {
			const dir = join(root, "docker", "seed-data", "hosts", host, instance);
			mkdirSync(dir, { recursive: true });
			for (const save of saves) writeFileSync(join(dir, save), "");
		}
	}
	return root;
}

test("the live seed tree derives the two-host cluster every tool used to hard-code", () => {
	assert.deepEqual(seededInstanceNames(), ["clusterio-host-1-instance-1", "clusterio-host-2-instance-1"]);
	const hosts = seededHosts();
	assert.equal(hosts[1].container, "surface-export-host-1");
	assert.equal(hosts[2].container, "surface-export-host-2");
	assert.equal(hosts[1].instance, "clusterio-host-1-instance-1");
});

test("a third seeded host enters the set with its own container name", () => {
	const root = tree({
		"clusterio-host-1": { "clusterio-host-1-instance-1": ["a.zip"] },
		"clusterio-host-3": { "clusterio-host-3-instance-1": ["c.zip"] },
	});
	try {
		const records = seededInstances(root);
		assert.deepEqual(records.map(r => r.container), ["surface-export-host-1", "surface-export-host-3"]);
		assert.deepEqual(records[1].seededSaves, ["c.zip"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("MUTATION KILL: an empty tree and a host dir without a number both refuse", () => {
	const empty = tree({});
	mkdirSync(join(empty, "docker", "seed-data", "hosts"), { recursive: true });
	const unnumbered = tree({ "clusterio-host-a": { "clusterio-host-a-instance-1": ["a.zip"] } });
	try {
		assert.throws(() => seededInstances(empty), /names no seeded instance/);
		assert.throws(() => seededInstances(unnumbered), /does not end in a host number/);
	} finally {
		rmSync(empty, { recursive: true, force: true });
		rmSync(unnumbered, { recursive: true, force: true });
	}
});
