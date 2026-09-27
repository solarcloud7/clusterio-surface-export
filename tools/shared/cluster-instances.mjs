// cluster-instances — live instance identity by assigned host, independent of instance names
// requires: clusterioctl `instance list` output (name | id | assignedHost columns); for data
//           directories, a listing of /clusterio/data/instances/*/instance.json from the host container
// produces: the one instance assigned to each host number (id, name, host, container), a name-or-id
//           lookup for explicit overrides, and each instance's host data directory matched by instance.id
// does not: rename, create or assign instances, choose between several instances on one host, or
//           treat seed directory names or data directory names as live identity

export const INSTANCE_DIRS_SCRIPT = "for f in /clusterio/data/instances/*/instance.json; do "
	+ "[ -f \"$f\" ] && printf '%s\\t' \"$f\" && tr -d '\\n\\r' < \"$f\" && echo; done";

export function parseInstanceList(output) {
	const lines = String(output).split(/\r?\n/).filter(line => line.includes("|"));
	const header = lines.shift()?.split("|").map(cell => cell.trim());
	if (!header?.includes("name") || !header.includes("status")) return [];
	return lines.filter(line => !/^[-\s|]+$/.test(line)).map(line => {
		const cells = line.split("|").map(cell => cell.trim());
		return Object.fromEntries(header.map((key, index) => [key, cells[index] ?? ""]));
	}).filter(row => row.name);
}

export function parseInstanceRows(output) {
	const text = String(output);
	const header = text.split(/\r?\n/).find(line => line.includes("|"))?.split("|").map(cell => cell.trim()) ?? [];
	const missing = ["name", "id", "assignedHost"].filter(column => !header.includes(column));
	if (missing.length) {
		throw new Error(`clusterioctl instance list has no ${missing.join("/")} column; raw output: ${text.trim().slice(0, 500) || "(empty)"}`);
	}
	return parseInstanceList(text).map(row => {
		const id = Number(row.id);
		if (!Number.isSafeInteger(id)) throw new Error(`clusterioctl instance list row ${JSON.stringify(row.name)} has no integer id (${JSON.stringify(row.id)})`);
		return { ...row, id };
	});
}

function describe(rows) {
	return rows.map(row => `${row.name} (id ${row.id}, host ${row.assignedHost || "unassigned"})`).join(", ") || "none";
}

export function instanceForHost(rows, host) {
	const matches = rows.filter(row => row.assignedHost === String(host));
	if (matches.length === 1) return matches[0];
	throw new Error(`host ${host} has ${matches.length ? `${matches.length} assigned instances` : "no assigned instance"}; `
		+ `expected exactly one. Instances: ${describe(rows)}. Name the instance explicitly (by name or id) instead.`);
}

export function instanceByNameOrId(rows, value) {
	const wanted = String(value).trim();
	const byId = /^\d+$/.test(wanted) ? rows.filter(row => String(row.id) === wanted) : [];
	const matches = byId.length ? byId : rows.filter(row => row.name === wanted);
	if (matches.length === 1) return matches[0];
	throw new Error(`${matches.length ? `${matches.length} instances match` : "no instance matches"} ${JSON.stringify(wanted)}; instances: ${describe(rows)}`);
}

export function parseInstanceDirs(output) {
	return String(output).split(/\r?\n/).filter(line => line.includes("\t")).map(line => {
		const tab = line.indexOf("\t");
		const file = line.slice(0, tab);
		let config;
		try { config = JSON.parse(line.slice(tab + 1)); }
		catch (error) { throw new Error(`${file} is not readable JSON: ${error.message}`); }
		return { dir: file.replace(/\/instance\.json$/, ""), id: Number(config["instance.id"]) };
	});
}

export function instanceDirFor(dirs, id, container) {
	const matches = dirs.filter(entry => entry.id === id);
	if (matches.length === 1) return matches[0].dir;
	throw new Error(`${container} has ${matches.length} instance directories for instance ${id}`
		+ ` (found: ${dirs.map(entry => `${entry.dir}=${entry.id}`).join(", ") || "none"})`);
}

export function createInstanceResolver({ list, readDirs, hosts = {} }) {
	let rows;
	const dirs = new Map();
	const all = () => rows ??= parseInstanceRows(list());
	const locate = row => {
		const host = Number(row.assignedHost);
		if (!Number.isSafeInteger(host) || host <= 0) throw new Error(`instance ${row.name} (id ${row.id}) is not assigned to a host`);
		return { id: row.id, name: row.name, host, container: hosts[host]?.container ?? `surface-export-host-${host}` };
	};
	return {
		all,
		forHost: host => locate(instanceForHost(all(), host)),
		byNameOrId: value => locate(instanceByNameOrId(all(), value)),
		dataDir(record) {
			if (!dirs.has(record.container)) dirs.set(record.container, parseInstanceDirs(readDirs(record.container)));
			return instanceDirFor(dirs.get(record.container), record.id, record.container);
		},
	};
}
