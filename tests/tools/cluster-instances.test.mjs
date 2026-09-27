import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
	createInstanceResolver, instanceByNameOrId, instanceDirFor, instanceForHost, parseInstanceDirs, parseInstanceRows,
} from "../../tools/shared/cluster-instances.mjs";

const HEADER = "name                        | id        | assignedHost | gamePort | status  | factorioVersion | startedAtMs   | updatedAtMs   | excludeFromStartAll\n"
	+ "---------------------------------------------------------------------------------------------------------------------------------------------------\n";
const table = rows => HEADER + rows.map(([name, id, host, status = "running"]) =>
	`${name} | ${id} | ${host} | 34${host}00 | ${status} | 2.1.20 | 1 | 2 | false`).join("\n") + "\n";
const SEEDED = table([["clusterio-host-1-instance-1", 836570928, 1], ["clusterio-host-2-instance-1", 902099405, 2]]);
const RENAMED = table([["Dev One", 836570928, 1], ["Dev Two", 902099405, 2, "stopped"]]);
const dirLine = (dir, id) => `${dir}/instance.json\t{\t"instance.name": "x",\t"instance.id": ${id},\t"instance.assigned_host": 1}`;

test("the captured clusterioctl table resolves each host to its instance id", () => {
	const rows = parseInstanceRows(SEEDED);
	assert.deepEqual([1, 2].map(host => instanceForHost(rows, host).id), [836570928, 902099405]);
	assert.equal(instanceForHost(rows, 2).name, "clusterio-host-2-instance-1");
});

test("renamed instances with spaces resolve to the same ids by host", () => {
	const rows = parseInstanceRows(RENAMED);
	assert.deepEqual([1, 2].map(host => instanceForHost(rows, host).id), [836570928, 902099405]);
	assert.equal(instanceForHost(rows, 1).name, "Dev One");
	assert.equal(instanceForHost(rows, 2).status, "stopped");
});

test("a host with no instance or two instances is refused and names the candidates", () => {
	const rows = parseInstanceRows(table([["Dev One", 1, 1], ["Seed retry", 3, 1], ["Dev Two", 2, 2]]));
	assert.throws(() => instanceForHost(rows, 1), /host 1 has 2 assigned instances.*Dev One \(id 1, host 1\), Seed retry \(id 3, host 1\)/);
	assert.throws(() => instanceForHost(rows, 3), /host 3 has no assigned instance/);
	assert.throws(() => instanceForHost(parseInstanceRows(table([["Dev One", 1, ""]])), 1), /no assigned instance/);
});

test("a failed or unrecognised list is an error carrying the raw output, never zero instances", () => {
	assert.throws(() => parseInstanceRows(""), /no name\/id\/assignedHost column; raw output: \(empty\)/);
	assert.throws(() => parseInstanceRows("Error: Failed to connect to controller"), /raw output: Error: Failed to connect/);
	assert.throws(() => parseInstanceRows("name | status\n---\nDev One | running\n"), /no id\/assignedHost column/);
	assert.throws(() => parseInstanceRows(table([["Dev One", "abc", 1]])), /has no integer id/);
});

test("a second instance on a host defers to the seed-named one, and refuses when none carries the seed name", () => {
	const gallery = ["surface-export-lab-gallery", 907164846, 2];
	const seedNamed = parseInstanceRows(table([["clusterio-host-1-instance-1", 836570928, 1], gallery, ["clusterio-host-2-instance-1", 902099405, 2]]));
	assert.equal(instanceForHost(seedNamed, 2, "clusterio-host-2-instance-1").id, 902099405);
	assert.equal(instanceForHost(seedNamed, 1, "Dev One").id, 836570928);
	const renamed = parseInstanceRows(table([["Dev One", 836570928, 1], gallery, ["Dev Two", 902099405, 2]]));
	assert.throws(() => instanceForHost(renamed, 2, "clusterio-host-2-instance-1"),
		/host 2 has 2 assigned instances, none uniquely named like its seed \(clusterio-host-2-instance-1\)/);
	assert.throws(() => instanceForHost(renamed, 2), /none uniquely named like its seed \(no seed name\)/);
	const resolver = createInstanceResolver({ hosts: { 2: { container: "surface-export-host-2", instance: "clusterio-host-2-instance-1" } },
		list: () => table([["clusterio-host-2-instance-1", 902099405, 2], gallery]), readDirs: () => "" });
	assert.equal(resolver.forHost(2).id, 902099405);
});

test("overrides match an id before a name, and refuse ambiguity", () => {
	const rows = parseInstanceRows(table([["Dev One", 836570928, 1], ["902099405", 7, 1], ["Dev Two", 902099405, 2]]));
	assert.equal(instanceByNameOrId(rows, "Dev One").id, 836570928);
	assert.equal(instanceByNameOrId(rows, "902099405").name, "Dev Two");
	assert.throws(() => instanceByNameOrId(rows, "Dev Three"), /no instance matches "Dev Three"/);
	assert.throws(() => instanceByNameOrId(parseInstanceRows(table([["Dup", 1, 1], ["Dup", 2, 2]])), "Dup"), /2 instances match "Dup"/);
});

test("the data directory is matched by instance.id when its name differs from the instance name", () => {
	const dirs = parseInstanceDirs([dirLine("/clusterio/data/instances/clusterio-host-1-instance-1", 836570928),
		dirLine("/clusterio/data/instances/Dev One", 5)].join("\n"));
	assert.equal(instanceDirFor(dirs, 836570928, "surface-export-host-1"), "/clusterio/data/instances/clusterio-host-1-instance-1");
	assert.equal(instanceDirFor(dirs, 5, "surface-export-host-1"), "/clusterio/data/instances/Dev One");
	assert.throws(() => instanceDirFor(dirs, 902099405, "surface-export-host-1"), /surface-export-host-1 has 0 instance directories for instance 902099405/);
	assert.throws(() => parseInstanceDirs("/x/instance.json\t{broken"), /\/x\/instance.json is not readable JSON/);
});

test("the resolver reads the list once, follows an override's assigned host, and caches directory listings per container", () => {
	let lists = 0;
	const reads = [];
	const resolver = createInstanceResolver({
		hosts: { 1: { container: "surface-export-host-1" }, 2: { container: "surface-export-host-2" } },
		list: () => { lists++; return RENAMED; },
		readDirs: container => { reads.push(container); return dirLine("/clusterio/data/instances/clusterio-host-2-instance-1", 902099405); },
	});
	assert.deepEqual(resolver.forHost(1), { id: 836570928, name: "Dev One", host: 1, container: "surface-export-host-1" });
	const override = resolver.byNameOrId("Dev Two");
	assert.deepEqual(override, { id: 902099405, name: "Dev Two", host: 2, container: "surface-export-host-2" });
	assert.equal(resolver.dataDir(override), "/clusterio/data/instances/clusterio-host-2-instance-1");
	assert.equal(resolver.dataDir(resolver.forHost(2)), "/clusterio/data/instances/clusterio-host-2-instance-1");
	assert.equal(lists, 1);
	assert.deepEqual(reads, ["surface-export-host-2"]);
});

const noPowerShell = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" }).status !== 0;

test("the PowerShell helpers resolve the same host, id and directory from the same text", { skip: noPowerShell }, () => {
	const script = `
. ./tools/shared/instance-identity.ps1
$rows = @(ConvertFrom-InstanceList -Raw @($env:SE_LIST -split "\\n"))
$picked = Select-InstanceForHost -Instances $rows -HostNumber 2
$dir = Select-InstanceDataDir -Raw @($env:SE_DIRS -split "\\n") -InstanceId $picked.Id -Container fixture
try { Select-InstanceForHost -Instances $rows -HostNumber 3 | Out-Null; $refused = '' } catch { $refused = $_.Exception.Message }
$crowded = @(ConvertFrom-InstanceList -Raw @($env:SE_CROWDED -split "\\n"))
$tiebreak = (Select-InstanceForHost -Instances $crowded -HostNumber 2 -SeedName 'clusterio-host-2-instance-1').Id
try { Select-InstanceForHost -Instances $crowded -HostNumber 2 -SeedName 'Dev Two' | Out-Null; $ambiguous = '' } catch { $ambiguous = $_.Exception.Message }
$seed = Get-SeedInstanceName -HostNumber 2
try { ConvertFrom-InstanceList -Raw @('Error: not connected') | Out-Null; $empty = '' } catch { $empty = $_.Exception.Message }
@{ name = $picked.Name; id = $picked.Id; status = $picked.Status; dir = $dir; refused = $refused; empty = $empty; tiebreak = $tiebreak; ambiguous = $ambiguous; seed = $seed } | ConvertTo-Json -Compress`;
	const result = spawnSync("pwsh", ["-NoProfile", "-Command", script], {
		cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8",
		env: { ...process.env, SE_LIST: RENAMED, SE_DIRS: dirLine("/clusterio/data/instances/clusterio-host-2-instance-1", 902099405),
			SE_CROWDED: table([["surface-export-lab-gallery", 907164846, 2], ["clusterio-host-2-instance-1", 902099405, 2]]) },
	});
	assert.equal(result.status, 0, result.stderr);
	const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
	assert.deepEqual({ name: parsed.name, id: parsed.id, status: parsed.status, dir: parsed.dir },
		{ name: "Dev Two", id: "902099405", status: "stopped", dir: "/clusterio/data/instances/clusterio-host-2-instance-1" });
	assert.match(parsed.refused, /Host 3 has 0 assigned instance\(s\)/);
	assert.match(parsed.empty, /no name\/id\/assignedHost\/status column; raw output: Error: not connected/);
	assert.equal(parsed.tiebreak, "902099405");
	assert.match(parsed.ambiguous, /Host 2 has 2 assigned instance\(s\), none uniquely named like its seed \(Dev Two\)/);
	assert.equal(parsed.seed, "clusterio-host-2-instance-1");
});
