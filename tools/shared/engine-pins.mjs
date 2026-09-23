import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT, seededInstances } from "./seeded-instances.mjs";

export const contract = {
	requires: ["seed instance configuration", "docker-compose.yml", ".github/workflows/ci.yml", ".env.example", "vendored Factorio API indexes"],
	produces: ["the seed engine pin and each checked-in copy that disagrees with it"],
	"does not": ["read a local .env or running containers", "parse documentation", "decide which copy is correct"],
};

const API_DIR = "docker/seed-data/external_plugins/surface_export/scripts";
const VERSION = /^\d+\.\d+\.\d+$/;

function compareVersions(a, b) {
	const [x, y] = [a, b].map(value => String(value).split(".").map(Number));
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
	return 0;
}

export function checkEnginePins(root = REPO_ROOT) {
	const read = path => readFileSync(join(root, path), "utf8");
	const seeds = seededInstances(root).map(h => ({ instance: h.instance,
		version: JSON.parse(read(join("docker/seed-data/hosts", h.host, h.instance, "instance.json")))["factorio.version"] }));
	const versions = [...new Set(seeds.map(seed => seed.version))];
	if (versions.length !== 1 || !VERSION.test(versions[0] || "")) {
		return { pin: null, problems: [`seed factorio.version must be one exact version: ${seeds.map(s => `${s.instance}=${s.version}`).join(", ")}`] };
	}
	const [pin] = versions;
	const volume = `factorio-client-${pin.replaceAll(".", "")}`;
	const problems = [];

	const compose = read("docker-compose.yml");
	const tags = [...compose.matchAll(/^\s*-\s*FACTORIO_CLIENT_TAG=(\S+)\s*$/gm)].map(match => match[1]);
	if (tags.length !== 1 || tags[0] !== pin) problems.push(`docker-compose.yml FACTORIO_CLIENT_TAG is ${tags.join(", ") || "missing"}; expected ${pin}`);
	const mounts = [...compose.matchAll(/^\s+-\s*([A-Za-z0-9][A-Za-z0-9_.-]*):\/opt\/factorio-client\s*$/gm)].map(match => match[1]);
	if (mounts.length !== 1 || mounts[0] !== volume) problems.push(`docker-compose.yml mounts client volume ${mounts.join(", ") || "none"}; expected ${volume}`);
	if (!new RegExp(`^  ${volume}:[^\\n]*\\n\\s+external:\\s*true`, "m").test(compose)) {
		problems.push(`docker-compose.yml does not declare ${volume} as an external volume`);
	}

	const ciVolumes = [...read(".github/workflows/ci.yml").matchAll(/docker volume create (factorio-client\S*)/g)].map(match => match[1]);
	if (!ciVolumes.length || ciVolumes.some(name => name !== volume)) problems.push(`ci.yml creates ${ciVolumes.join(", ") || "no client volume"}; expected ${volume}`);

	if (/FACTORIO_CLIENT_TAG=/.test(read(".env.example"))) problems.push(".env.example sets FACTORIO_CLIENT_TAG; docker-compose.yml is its only source");

	const index = JSON.parse(read(`${API_DIR}/factorio-api-index.json`));
	if (index.application_version !== pin) problems.push(`factorio-api-index.json is for ${index.application_version}; expected ${pin}`);
	const floor = JSON.parse(read(`${API_DIR}/factorio-api-floor-index.json`));
	if (!VERSION.test(floor.application_version || "") || compareVersions(floor.application_version, pin) > 0 || floor.api_version !== index.api_version) {
		problems.push(`factorio-api-floor-index.json (${floor.application_version}, api ${floor.api_version}) must not be newer than ${pin} (api ${index.api_version})`);
	}
	return { pin, floor: floor.application_version, problems };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	const { pin, floor, problems } = checkEnginePins();
	for (const problem of problems) console.error(problem);
	if (problems.length) process.exit(1);
	console.log(`Engine pins agree on Factorio ${pin}; API floor ${floor}`);
}
