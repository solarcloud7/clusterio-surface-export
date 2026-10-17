// requires: a DockerLab whose instances run without user verification, the full client volume named in docker-compose.yml, the testkit client graphics image
// produces: a labelled client container in the lab network that joins one instance with --mp-connect under Xvfb, its log and X screenshots
// does not: use Steam or a Factorio account, verify pointer input, or approve visual layout
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../transfer-reliability/docker-lab.mjs";

const LABEL = "surface-export.manual-run";
const BUILTIN = new Set(["base", "quality", "elevated-rails", "recycler", "space-age"]);

export function clientVolume() {
	const compose = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
	const volume = compose.match(/^\s+- ([A-Za-z0-9][A-Za-z0-9_.-]*):\/opt\/factorio-client\s*$/m)?.[1];
	assert.ok(volume, "Cannot resolve the configured full client volume");
	return volume;
}

export function serverMods(lab, host) {
	const raw = lab.docker(["exec", lab.hosts[host].container, "sh", "-c",
		"grep -h -o -E 'Loading mod [A-Za-z0-9_-]+ [0-9.]+' /clusterio/data/instances/*/factorio-current.log | sort -u"]);
	return raw.trim().split(/\r?\n/).filter(Boolean).map(line => {
		const [, , name, version] = line.split(" ");
		return { name, version };
	}).filter(mod => mod.name !== "core");
}

export function gamePort(lab, host) {
	const header = ["name", "id", "assignedHost", "gamePort"];
	const rows = lab.ctl("instance", "list").split(/\r?\n/).map(line => line.split("|").map(cell => cell.trim()));
	assert.deepEqual(rows[0].slice(0, 4), header, "unexpected instance list columns");
	const port = Number(rows.find(row => row[0] === lab.hosts[host].instance)?.[3]);
	assert.ok(Number.isInteger(port) && port > 0, `no game port listed for ${lab.hosts[host].instance}`);
	return port;
}

export function startClient(lab, { host, name, image, player = "pauselab", width = 1280, height = 800 }) {
	assert.match(name, /^client-[a-z0-9-]+$/);
	const work = join(lab.directory, name), mods = join(work, "mods");
	mkdirSync(join(work, "user"), { recursive: true }); mkdirSync(mods, { recursive: true });
	const listed = serverMods(lab, host);
	for (const mod of listed.filter(mod => !BUILTIN.has(mod.name))) {
		const file = `${mod.name}_${mod.version}.zip`;
		cpSync(join(ROOT, "docker/seed-data/mods", file), join(mods, file));
	}
	lab.docker(["cp", `${lab.hosts[host].container}:/clusterio/data/instances/${lab.hosts[host].instance}/mods/mod-settings.dat`, join(mods, "mod-settings.dat")]);
	writeFileSync(join(mods, "mod-list.json"), JSON.stringify({ mods: listed.map(mod => ({ name: mod.name, enabled: true })) }, null, 2));
	writeFileSync(join(work, "user/player-data.json"), JSON.stringify({ "service-username": player }));
	writeFileSync(join(work, "config.ini"), "; version=13\n[path]\nread-data=/opt/factorio-client/data\nwrite-data=/work/user\n[general]\nlocale=en\n[other]\ncheck-updates=false\n");
	const address = `${lab.hosts[host].container}:${gamePort(lab, host)}`;
	writeFileSync(join(work, "launch.sh"), `set -eu
Xvfb :99 -screen 0 ${width}x${height}x24 -nolisten tcp &
i=0; while [ ! -S /tmp/.X11-unix/X99 ]; do i=$((i + 1)); [ "$i" -lt 100 ] || exit 1; sleep 0.1; done
export DISPLAY=:99
exec timeout --signal=TERM --kill-after=10s 900s /opt/factorio-client/bin/x64/factorio --config /work/config.ini --mod-directory /work/mods \\
  --mp-connect ${address} --disable-audio --window-size ${width}x${height} --force-graphics-preset very-low
`);
	const container = `${lab.run}-${name}`;
	lab.docker(["run", "-d", "--name", container, "--label", `${LABEL}=${lab.run}`, "--network", lab.network, "--no-healthcheck",
		"--cpus", "4", "--memory", "8g", "--shm-size", "512m",
		"--mount", `type=volume,src=${clientVolume()},dst=/opt/factorio-client,readonly`,
		"--mount", `type=bind,src=${work},dst=/work`, "--entrypoint", "/bin/sh", image, "/work/launch.sh"]);
	lab.containers.push(container);
	return { container, work, address, mods: listed };
}

export function screenshot(lab, client, label) {
	assert.match(label, /^[a-z0-9-]+$/);
	lab.docker(["exec", client.container, "sh", "-c", `DISPLAY=:99 xwd -root -silent | xwdtopnm 2>/dev/null | pnmtopng > /work/${label}.png`]);
	return join(client.work, `${label}.png`);
}

export function clientLog(lab, client) {
	return lab.docker(["exec", client.container, "sh", "-c", "tail -n 60 /work/user/factorio-current.log 2>/dev/null || true"]).split(/\r?\n/);
}

export function stopClient(lab, client) {
	lab.mutateContainer("rm", client.container, ["-f"]);
}
