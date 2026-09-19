import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { runCommand } from "../../shared/command-evidence.mjs";
import { withWorkflowLock } from "../../shared/workflow-lock.mjs";
import { sourceIdentity } from "../../shared/verification-evidence.mjs";

export const contract = {
	requires: ["Docker Linux engine", "configured full Factorio client volume", "pinned development host image"],
	produces: ["isolated graphical captures", "virtual-display pointer input on request", "source and runtime identity", "owned container cleanup evidence"],
	"does not": ["use Steam", "modify the shared client volume", "deploy", "approve visual layout", "prove multiplayer or cargo behavior"],
};
const root = fileURLToPath(new URL("../../../", import.meta.url));
const recipe = fileURLToPath(new URL("client/", import.meta.url));
const artifacts = join(root, "ci-artifacts/client");
const label = "surface-export.client-run";
const scenarios = { smoke: ["smoke.png"], "gui-anchors": ["remote.png", "hub.png"], "remote-view-panels": ["small.png", "grown.png", "shrunk.png", "scrolling.png", "boarding.png", "no-planets.png", "no-boarding.png"] };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha = data => createHash("sha256").update(data).digest("hex");
const json = path => JSON.parse(readFileSync(path, "utf8"));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
const sleep = ms => new Promise(done => setTimeout(done, ms));

export function validateRunId(id) {
	assert.match(id || "", uuid, "Expected a client run UUID, not a path or container name");
	return id;
}

export function parseClientOptions(args) {
	const [action, ...rest] = args;
	assert.ok(["doctor", "run", "inspect", "cleanup"].includes(action),
		"usage: client doctor | run <smoke|remote-view-panels|gui-anchors> [--resolution 1600x1000] [--scale 1] [--timeout-seconds 240] | inspect <run-id> | cleanup <run-id>");
	if (action === "doctor") { assert.equal(rest.length, 0); return { action }; }
	if (action !== "run") { assert.equal(rest.length, 1); return { action, id: validateRunId(rest[0]) }; }
	const scenario = rest.shift();
	assert.ok(Object.hasOwn(scenarios, scenario), "Unknown graphical scenario");
	const options = { action, scenario, width: 1600, height: 1000, scale: 1, timeoutSeconds: 240 };
	const seen = new Set();
	while (rest.length) {
		const flag = rest.shift(), value = rest.shift();
		assert.ok(!seen.has(flag) && value, `Missing or repeated option ${flag}`); seen.add(flag);
		if (flag === "--resolution") {
			assert.match(value, /^\d{3,4}x\d{3,4}$/);
			[options.width, options.height] = value.split("x").map(Number);
			assert.ok(options.width >= 800 && options.width <= 3840 && options.height >= 600 && options.height <= 2160);
		} else if (flag === "--scale") {
			options.scale = Number(value); assert.ok([1, 1.25, 1.5, 1.75, 2].includes(options.scale));
		} else if (flag === "--timeout-seconds") {
			options.timeoutSeconds = Number(value);
			assert.ok(Number.isInteger(options.timeoutSeconds) && options.timeoutSeconds >= 30 && options.timeoutSeconds <= 600);
		} else throw new Error(`Unknown client option ${flag}`);
	}
	return options;
}

function docker(args, options = {}) { return runCommand("docker", args, { cwd: root, ...options }).stdout.trim(); }

export function cleanupRun(id, command = docker) {
	validateRunId(id);
	const names = command(["ps", "-a", "--filter", `label=${label}=${id}`, "--format", "{{.Names}}"])
		.split(/\r?\n/).filter(Boolean);
	for (const name of names) {
		assert.ok(name.startsWith(`se-client-${id}-`), "Refusing unexpected resource name");
		assert.equal(command(["container", "inspect", name, "--format", `{{ index .Config.Labels "${label}" }}`]), id,
			"Refusing container with different ownership");
		command(["rm", "-f", name]);
	}
	assert.equal(command(["ps", "-aq", "--filter", `label=${label}=${id}`]), "", "Owned containers remain");
	return { success: true, removed: names };
}

function configuredClient() {
	const compose = readFileSync(join(root, "docker-compose.yml"), "utf8");
	const volume = compose.match(/^\s+- ([A-Za-z0-9][A-Za-z0-9_.-]*):\/opt\/factorio-client\s*$/m)?.[1];
	assert.ok(volume, "Cannot resolve the configured full client volume");
	const expectedVersion = json(join(root, "docker/seed-data/external_plugins/surface_export/scripts/factorio-api-index.json")).application_version;
	assert.match(expectedVersion, /^\d+\.\d+\.\d+$/);
	return { volume, expectedVersion };
}

export function verifyVersion(output, expected) {
	const found = output.match(/^Version: (\d+\.\d+\.\d+) \([^\n]*linux64, full\)/m)?.[1];
	assert.equal(found, expected, `Expected the full Linux client ${expected}; no Steam or version fallback is allowed`);
	return found;
}

export function doctor() {
	docker(["version", "--format", "{{.Server.Version}}"]);
	const config = configuredClient();
	assert.equal(docker(["volume", "inspect", config.volume, "--format", "{{.Name}}"]), config.volume);
	const images = [...new Set(docker(["compose", "config", "--images"]).split(/\r?\n/))]
		.filter(value => /^ghcr\.io\/solarcloud7\/clusterio-docker-host:[\w.-]+\.r\d+$/.test(value));
	assert.equal(images.length, 1, "Expected one immutable development host image revision");
	const baseImage = docker(["image", "inspect", images[0], "--format", "{{.Id}}"]);
	assert.match(baseImage, /^sha256:[a-f0-9]{64}$/);
	const baseReference = JSON.parse(docker(["image", "inspect", images[0], "--format", "{{json .RepoDigests}}"]))
		.find(value => /^ghcr\.io\/solarcloud7\/clusterio-docker-host@sha256:[a-f0-9]{64}$/.test(value));
	assert.ok(baseReference, "Pinned host image has no registry digest");
	const id = randomUUID(), name = `se-client-${id}-doctor`;
	let output;
	try {
		docker(["create", "--name", name, "--label", `${label}=${id}`, "--network", "none",
			"--mount", `type=volume,src=${config.volume},dst=/opt/factorio-client,readonly`,
			"--entrypoint", "/opt/factorio-client/bin/x64/factorio", baseImage, "--version"]);
		output = docker(["start", "-a", name]);
	} finally { cleanupRun(id); }
	return { ...config, baseImage, baseReference, observedVersion: verifyVersion(output, config.expectedVersion),
		graphics: "Not tested by doctor; run smoke to verify rendering" };
}

function prepareGraphics(config, evidenceFile) {
	const tag = "surface-export-client-gui:" + sha(config.baseImage + readFileSync(join(recipe, "Dockerfile"))).slice(0, 16);
	docker(["build", "--build-arg", `BASE_IMAGE=${config.baseReference}`, "-t", tag, recipe],
		{ label: "client-graphics-build", evidenceFile, timeout: 600000, maxBuffer: 4 * 1024 * 1024 });
	return docker(["image", "inspect", tag, "--format", "{{.Id}}"]);
}

function stage(dir, id, options, version) {
	const work = join(dir, "work"), mods = join(work, "mods"), probe = join(mods, "se_client_probe_0.0.1");
	mkdirSync(probe, { recursive: true }); mkdirSync(join(work, "saves")); mkdirSync(join(work, "user"));
	const copy = (from, to) => cpSync(from, to, { recursive: true, filter: path => {
		assert.ok(!lstatSync(path).isSymbolicLink(), "Client staging refuses symbolic links"); return true;
	} });
	const names = ["base", "quality", "elevated-rails", "space-age", "se_client_probe"];
	if (options.scenario !== "smoke") {
		const source = join(root, "docker/seed-data");
		copy(join(source, "external_plugins/surface_export/module"), join(probe, "modules/surface_export"));
		const mod = json(join(source, "mods-src/surfexp_gateways/info.json"));
		copy(join(source, "mods-src/surfexp_gateways"), join(mods, `${mod.name}_${mod.version}`));
		names.push(mod.name);
	}
	save(join(probe, "info.json"), { name: "se_client_probe", version: "0.0.1", title: "Disposable client probe", author: "local",
		factorio_version: version.split(".").slice(0, 2).join("."), dependencies: names.filter(name => name !== "se_client_probe") });
	copy(join(recipe, "scenario.lua"), join(probe, "control.lua"));
	copy(join(recipe, "pointer.sh"), join(work, "pointer.sh"));
	writeFileSync(join(probe, "run.lua"), `return {id="${id}",scenario="${options.scenario}",width=${options.width},height=${options.height}}\n`);
	save(join(mods, "mod-list.json"), { mods: names.map(name => ({ name, enabled: true })) });
	save(join(work, "map-gen.json"), { seed: 69420, width: 128, height: 128, peaceful_mode: true });
	writeFileSync(join(work, "config.ini"), "; version=13\n[path]\nread-data=/opt/factorio-client/data\nwrite-data=/work/user\n[general]\nlocale=en\n[other]\ncheck-updates=false\n[interface]\nui-scale-mode=manual-pixels\ncustom-ui-scale=" + options.scale + "\n");
	writeFileSync(join(work, "launch.sh"), `set -eu
client=/opt/factorio-client/bin/x64/factorio
timeout --signal=TERM --kill-after=10s ${options.timeoutSeconds}s "$client" --config /work/config.ini --mod-directory /work/mods --create /work/saves/test.zip --map-gen-settings /work/map-gen.json
Xvfb :99 -screen 0 ${options.width}x${options.height}x24 -nolisten tcp &
i=0; while [ ! -S /tmp/.X11-unix/X99 ]; do i=$((i + 1)); [ "$i" -lt 100 ] || exit 1; sleep 0.1; done
export DISPLAY=:99
sh /work/pointer.sh &
exec timeout --signal=TERM --kill-after=10s ${options.timeoutSeconds}s "$client" --config /work/config.ini --mod-directory /work/mods --load-game /work/saves/test.zip --disable-audio --fullscreen=false --window-size ${options.width}x${options.height} --force-graphics-preset very-low
`);
	return work;
}

export function verifyCapture(report, expected, outputDir) {
	assert.equal(report.runId, expected.id, "Completion marker is from a different run");
	assert.equal(report.scenario, expected.scenario);
	assert.equal(report.status, "captured");
	assert.equal(report.engineVersion, expected.version);
	assert.deepEqual(report.screenshots, scenarios[expected.scenario], "Incomplete scenario captures");
	assert.deepEqual(report.resolution, { width: expected.width, height: expected.height }, "Unexpected client viewport");
	assert.equal(report.scale, expected.scale, "Unexpected UI scale");
	return report.screenshots.map(name => {
		const path = join(outputDir, name), bytes = readFileSync(path);
		assert.ok(bytes.length >= 67 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `Invalid PNG: ${name}`);
		assert.ok(bytes.subarray(-12).equals(Buffer.from("0000000049454e44ae426082", "hex")), `Incomplete PNG: ${name}`);
		assert.equal(bytes.readUInt32BE(16), expected.width); assert.equal(bytes.readUInt32BE(20), expected.height);
		return { name, path, sha256: sha(bytes), bytes: bytes.length };
	});
}

export async function waitForCapture({ read, verify, running, timeoutMs, now = () => performance.now(), pause = sleep }) {
	const deadline = now() + timeoutMs;
	let pending;
	while (true) {
		try {
			const data = read();
			if (data) return verify(data);
		} catch (error) {
			if (error.code !== "ENOENT" && !(error instanceof SyntaxError) && !error.message.startsWith("Incomplete PNG:")) throw error;
			pending = error;
		}
		assert.ok(running(), "Client stopped before verified captures");
		assert.ok(now() < deadline, pending ? `Capture deadline: ${pending.message}` : "Timed out waiting for screenshots and completion marker");
		await pause(500);
	}
}

export async function runClient(options) {
	return withWorkflowLock(async () => {
		const id = randomUUID(), dir = join(artifacts, id);
		mkdirSync(dir, { recursive: true });
		const reportFile = join(dir, "report.json"), evidenceFile = join(dir, "commands.jsonl");
		const report = { id, scenario: options.scenario, status: "running", visualReview: "not reviewed", startedAt: new Date().toISOString() };
		save(reportFile, report);
		try {
			report.source = sourceIdentity(root);
			report.runtime = doctor();
			report.graphicsImage = prepareGraphics(report.runtime, evidenceFile);
			const work = stage(dir, id, options, report.runtime.expectedVersion), name = `se-client-${id}-gui`;
			report.options = options;
			save(reportFile, report);
			const invoke = (args, extra = {}) => docker(args, { evidenceFile, ...extra });
			invoke(["create", "--name", name, "--label", `${label}=${id}`, "--network", "none", "--no-healthcheck", "--cpus", "4", "--memory", "8g", "--shm-size", "512m",
				"--mount", `type=volume,src=${report.runtime.volume},dst=/opt/factorio-client,readonly`,
				"--mount", `type=bind,src=${work},dst=/work`, "--entrypoint", "/bin/sh", report.graphicsImage, "/work/launch.sh"]);
			invoke(["start", name]);
			const output = join(work, "user/script-output"), marker = join(output, "client-result.json");
			report.screenshots = await waitForCapture({
				read: () => existsSync(marker) ? json(marker) : null,
				verify: data => verifyCapture(data, { ...options, id, version: report.runtime.expectedVersion }, output),
				running: () => invoke(["container", "inspect", name, "--format", "{{.State.Running}}"], { tailChars: 0 }) === "true",
				timeoutMs: options.timeoutSeconds * 1000,
			});
			report.finishedSource = sourceIdentity(root);
			assert.equal(report.source.sourceSha256, report.finishedSource.sourceSha256, "Source changed during the capture run");
			report.status = "captured";
		} catch (error) {
			report.status = "failed"; report.error = error.message;
		} finally {
			try {
				const names = docker(["ps", "-a", "--filter", `label=${label}=${id}`, "--format", "{{.Names}}"]);
				for (const name of names.split(/\r?\n/).filter(Boolean)) {
					const logs = runCommand("docker", ["logs", "--tail", "250", name], { evidenceFile, label: "client-log", tailChars: 24000 });
					writeFileSync(join(dir, "client.log"), logs.record.stdout + "\n" + logs.record.stderr);
				}
			} catch (error) { report.logError = error.message; }
			try { report.cleanup = cleanupRun(id, args => docker(args, { evidenceFile })); }
			catch (error) { report.cleanup = { success: false, error: error.message }; report.status = "failed"; }
			report.finishedAt = new Date().toISOString(); save(reportFile, report);
		}
		console.log(JSON.stringify({ ...report, reportFile }, null, 2));
		if (report.status !== "captured") process.exitCode = 1;
		return report;
	});
}

export async function clientCommand(args) {
	const options = parseClientOptions(args);
	if (options.action === "doctor") return withWorkflowLock(() => console.log(JSON.stringify(doctor(), null, 2)));
	if (options.action === "run") return runClient(options);
	if (options.action === "inspect") {
		const report = json(join(artifacts, options.id, "report.json"));
		assert.equal(report.id, options.id);
		console.log(JSON.stringify(report, null, 2)); return report;
	}
	return withWorkflowLock(() => {
		const result = cleanupRun(options.id);
		console.log(JSON.stringify({ id: options.id, cleanup: result, evidenceRetained: true }, null, 2));
		return result;
	});
}
