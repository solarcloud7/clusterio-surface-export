// seeded-instances — the cluster's expected instance set, derived from the seed-data tree
// requires: docker/seed-data/hosts/<host>/<instance>/ directories (the seeding convention)
// produces: one record per seeded instance — host dir, host number, host container name, instance
//           name, seeded save zips — sorted by host then instance; throws when the tree names none
// does not: contact the cluster, read instance.json, or decide which instance plays which role

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function seededInstances(root = REPO_ROOT) {
	const hostsDir = join(root, "docker", "seed-data", "hosts");
	const records = [];
	for (const host of readdirSync(hostsDir).sort()) {
		const hostDir = join(hostsDir, host);
		if (!statSync(hostDir).isDirectory()) continue;
		const numberMatch = /(\d+)$/.exec(host);
		if (!numberMatch) throw new Error(`${hostDir} does not end in a host number — the container name cannot be derived`);
		const hostNumber = Number(numberMatch[1]);
		for (const instance of readdirSync(hostDir).sort()) {
			const instanceDir = join(hostDir, instance);
			if (!statSync(instanceDir).isDirectory()) continue;
			records.push({
				host,
				hostNumber,
				container: `surface-export-host-${hostNumber}`,
				instance,
				seededSaves: readdirSync(instanceDir).filter(f => f.endsWith(".zip")).sort(),
			});
		}
	}
	if (!records.length) throw new Error(`${hostsDir} names no seeded instance — a gate over this set would gate on nothing`);
	return records;
}

export function seededInstanceNames(root = REPO_ROOT) {
	return seededInstances(root).map(r => r.instance);
}

export function seededHosts(root = REPO_ROOT) {
	const byNumber = new Map();
	for (const r of seededInstances(root)) {
		if (!byNumber.has(r.hostNumber)) byNumber.set(r.hostNumber, { ...r, instances: [] });
		byNumber.get(r.hostNumber).instances.push(r.instance);
	}
	return Object.fromEntries([...byNumber.entries()].map(([n, h]) => [n, h]));
}
