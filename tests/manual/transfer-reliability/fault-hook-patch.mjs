// Applied to the plugin's InstancePlugin class by the statement fault-hook-loader.mjs appends to the instance entrypoint.
// requires: SE_MANUAL_RUN naming a disposable lab run; /clusterio/data/manual-fault.json written by the lab driver
// produces: the four transfer handlers wrapped so that one accepted, scoped reply named by the rule is held forever and every scoped call is recorded in /clusterio/data/manual-events.jsonl
// does not: fabricate a success or an error, hold a reply the rule does not name, or hold the same name twice in one process
import realFs from "node:fs";

const METHODS = [
	["handleDeleteSourcePlatformMeasured", "source"],
	["handleDestinationTransferGate", "destination"],
	["handleImportPlatformRequestMeasured", "import"],
	["handleExportPlatformRequestMeasured", "export"],
];
const patched = Symbol.for("surface-export.manual-fault-hook");

export function patch(InstancePlugin, { fs = realFs, env = process.env, pid = process.pid,
	rulePath = "/clusterio/data/manual-fault.json", eventsPath = "/clusterio/data/manual-events.jsonl" } = {}) {
	const run = env.SE_MANUAL_RUN;
	if (!/^se-manual-[a-z0-9-]{8,60}$/.test(run || "")) throw new Error("Manual fault hook requires disposable run identity");
	const proto = InstancePlugin?.prototype;
	if (!proto) throw new Error("Manual interception needs the InstancePlugin class");
	if (proto[patched]) return false;
	proto[patched] = true;
	const consumed = new Set();
	const readRule = () => fs.existsSync(rulePath) ? JSON.parse(fs.readFileSync(rulePath, "utf8")) : {};
	const record = event => fs.appendFileSync(eventsPath, JSON.stringify({ run, pid, utc: new Date().toISOString(), ...event }) + "\n");
	for (const [method, action] of METHODS) {
		const original = proto[method];
		if (typeof original !== "function") throw new Error(`Manual interception missing ${method}`);
		proto[method] = async function (req) {
			let id = String(req.transferId || req.exportId || req.exportData?._transferId || "");
			let scoped = id.includes(`transfer-cleanup-${run}-`);
			if (scoped) record({ kind: "call", action, id, gate: req.action });
			const response = await original.call(this, req);
			if (action === "export") {
				id = String(response?.exportId || ""); scoped = id.includes(`transfer-cleanup-${run}-`);
				if (scoped) record({ kind: "call", action, id, operationId: req.operationId });
			}
			const rule = readRule();
			if (scoped && response?.success === true && rule.run === run && rule.enabled === true
				&& rule.action === action && id.includes(rule.name) && !consumed.has(rule.name)
				&& (action !== "destination" || req.action === "go_live")) {
				consumed.add(rule.name);
				record({ kind: "response-held", action, id, name: rule.name, success: true });
				// Do not fabricate an error or success. The driver disconnects the requester.
				// This old handler never returns; a later retry uses the real receipt path.
				return new Promise(() => {});
			}
			if (scoped) record({ kind: "return", action, id, gate: req.action, success: response?.success === true });
			return response;
		};
	}
	return true;
}
