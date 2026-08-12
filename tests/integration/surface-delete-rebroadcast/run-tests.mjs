#!/usr/bin/env node
// surface-delete-rebroadcast — does an out-of-band surface deletion actually reach the controller?
//
// requires: a running surface-export cluster
// produces: exit 0 when the deletion emits a tree rebroadcast, exit 1 when it does not
// does not: assert the canvas row disappears (that is the subscriber's job), or exercise a transfer
//
// #206 shipped a handler that never fired. Nothing asserted the producer emits, so the dead path
// looked identical to a working one for a full merge cycle. This asserts the emit.

import { execFileSync } from "node:child_process";

const HOST = "surface-export-host-2";
const INSTANCE = "clusterio-host-2-instance-1";
const PROBE = `deleteprobe-${Date.now().toString(36)}`;

const rcon = (lua) => execFileSync("docker", [
	"exec", "surface-export-controller", "sh", "-c",
	`npx clusterioctl --config /clusterio/tokens/config-control.json --log-level error `
	+ `instance send-rcon "${INSTANCE}" ${JSON.stringify(lua)}`,
], { encoding: "utf8" }).trim();

// Counted inside the container, not pulled out of it: the host log grows without bound and reading it
// whole blew execFileSync's buffer (spawnSync ENOBUFS) on the first live run. `|| true` because grep
// exits 1 on no-match, which execFileSync would raise as a throw.
const logCount = (needle) => Number(execFileSync("docker", [
	"exec", HOST, "sh", "-c",
	`grep -acF ${JSON.stringify(needle)} /clusterio/logs/host/host-*.log 2>/dev/null | `
	+ `awk -F: '{ s += $NF } END { print s+0 }' || true`,
], { encoding: "utf8" }).trim() || 0);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (ok, label, detail = "") => {
	console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
	// Set at the point of failure, not only at the terminal exit(): an early return past that exit
	// would otherwise report a recorded FAILURE as a green run — the vacuous-pass class again.
	if (!ok) { failures += 1; process.exitCode = 1; }
};

async function main() {
	console.log(`=== surface-delete rebroadcast (probe ${PROBE}) ===`);
	let platformIndex = null;

	try {
		const created = rcon(`/sc local p = game.forces.player.create_space_platform({name=[[${PROBE}]], `
			+ `planet=[[nauvis]], starter_pack=[[space-platform-starter-pack]]}) p.apply_starter_pack() `
			+ `rcon.print(p.index .. [[|]] .. p.surface.index)`);
		const [index, surfaceIndex] = created.split("|").map(Number);
		platformIndex = index;
		check(Number.isInteger(index) && Number.isInteger(surfaceIndex), "probe platform created", created);
		if (!Number.isInteger(index)) { return; }

		const marker = `Tree rebroadcast requested: surface ${surfaceIndex} deleted`;
		const before = logCount(marker);

		// The name guard is the whole safety story for a destructive call on a shared cluster: the index
		// is resolved fresh and the delete only runs if it still names the throwaway.
		const deleted = rcon(`/sc local p = game.forces.player.platforms[${index}] `
			+ `if p and p.valid and p.name == [[${PROBE}]] then game.delete_surface(p.surface) `
			+ `rcon.print([[deleted]]) else rcon.print([[REFUSED: ]] .. tostring(p and p.name)) end`);
		check(deleted === "deleted", "probe surface deleted", deleted);

		await sleep(6000);

		const after = logCount(marker);
		check(after > before,
			"the deletion emitted a tree rebroadcast",
			`"${marker}" count ${before} -> ${after}; this is the assertion #206 lacked — its handler `
			+ "never fired and nothing noticed");
	} finally {
		// The happy path deletes the probe as its subject; this is the FAILURE path's net. Without it a
		// failed run leaks a platform, and cleanup-test-surfaces.ps1 only sweeps registered prefixes.
		if (Number.isInteger(platformIndex)) {
			rcon(`/sc local p = game.forces.player.platforms[${platformIndex}] `
				+ `if p and p.valid and p.name == [[${PROBE}]] then game.delete_surface(p.surface) end `
				+ `rcon.print([[cleanup done]])`);
		}
		const still = rcon(`/sc local names = {} for _, p in pairs(game.forces.player.platforms) do `
			+ `names[#names+1] = p.name end rcon.print(table.concat(names, [[,]]))`);
		check(!still.includes(PROBE), "probe swept", `platforms now: ${still || "(none)"}`);
	}

	console.log(failures === 0 ? "\nsurface-delete-rebroadcast: PASS" : `\nsurface-delete-rebroadcast: ${failures} FAILURE(S)`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error(`surface-delete-rebroadcast: ${err.message}`);
	process.exit(1);
});
