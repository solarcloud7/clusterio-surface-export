#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const CONTROLLER = "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";
const INSTANCE = "clusterio-host-1-instance-1";
const CHUNK_SIZE = 8_000;

let failed = 0;
const check = (ok, label, detail = "") => {
	console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failed++;
};

function rcon(command) {
	return execFileSync("docker", ["exec", CONTROLLER, "npx", "clusterioctl", "--log-level", "error",
		"instance", "send-rcon", INSTANCE, command, "--config", CTL_CONFIG],
	{ encoding: "utf8", timeout: 180_000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 }).trim();
}

function lua(body) {
	const command = `/sc local ok,result=pcall(function() ${body} end); ` +
		`if ok then rcon.print(helpers.table_to_json(result)) ` +
		`else rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) end`;
	const raw = rcon(command).split(/\r?\n/).map(l => l.trim()).filter(Boolean).at(-1) || "";
	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new Error(`Invalid Lua JSON: ${raw.slice(0, 300)}\n${error.message}`);
	}
}

function remoteCall(expr, phase) {
	const res = lua(`return ${expr}`);
	if (res.ok !== true) {
		throw new Error(`${phase} refused: ${JSON.stringify(res)}`);
	}
	return res;
}

function expectRefusal(expr, phase, pattern) {
	const res = lua(`return ${expr}`);
	check(res.success === false && pattern.test(String(res.error)),
		`refusal: ${phase}`, JSON.stringify(res));
}

function toAsciiJson(json) {
	return json.replace(/[\u007f-\uffff]/g,
		ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function simpleChecksum(ascii) {
	let hash = 0;
	for (let i = 0; i < ascii.length; i++) {
		hash = (hash * 31 + ascii.charCodeAt(i)) % 4294967296;
	}
	return hash.toString(16).padStart(8, "0");
}

function bracketWrap(text) {
	for (let level = 1; level < 10; level++) {
		const eq = "=".repeat(level);
		if (!(text + "]").includes(`]${eq}]`)) return `[${eq}[${text}]${eq}]`;
	}
	throw new Error("no safe long-bracket level found");
}

function synthesizeConfig() {
	const keyed = {};
	for (let g = 1; g <= 4; g++) {
		const targets = [];
		for (let t = 0; t < 60; t++) {
			const marker = g === 1 && t === 0 ? "über-工場-" : "";
			targets.push({
				instanceId: 1000 * g + t,
				instanceName: `${marker}synthetic-instance-${g}-${t}-${"n".repeat(300)}`,
				targetGateway: `surfexp_gateway_${g}`,
				online: false,
			});
		}
		keyed[`surfexp_gateway_${g}`] = { targets };
	}
	return keyed;
}

async function main() {
	console.log("=== gateway-config-chunking: an oversized config rides begin/chunk/commit with echo-verify ===");

	const snapshot = lua(
		"return { ok = true, gateways = helpers.table_to_json(storage.surface_export_config "
		+ "and storage.surface_export_config.gateways or {}) }");
	if (snapshot.ok !== true) throw new Error("could not snapshot the live gateway config");

	try {
		const keyed = synthesizeConfig();
		const json = JSON.stringify(keyed);
		const ascii = toAsciiJson(json);
		const checksum = simpleChecksum(ascii);
		const chunks = [];
		for (let i = 0; i < ascii.length; i += CHUNK_SIZE) chunks.push(ascii.slice(i, i + CHUNK_SIZE));
		console.log(`  synthesized config: ${ascii.length} ASCII bytes, ${chunks.length} chunks, checksum=${checksum}`);
		check(chunks.length >= 3, "the synthesized config is genuinely oversized", `chunks=${chunks.length}`);

		const token = `gwtest_${Date.now().toString(36)}`;
		remoteCall(`remote.call('surface_export','configure_gateways_begin','${token}',${chunks.length},'${checksum}')`,
			"begin");
		for (let i = 0; i < chunks.length; i++) {
			const res = remoteCall(
				`remote.call('surface_export','configure_gateways_chunk','${token}',${i + 1},${bracketWrap(chunks[i])})`,
				`chunk ${i + 1}`);
			check(res.received === i + 1, `chunk ${i + 1}/${chunks.length} acknowledged`, JSON.stringify(res));
		}
		const commit = remoteCall(
			`remote.call('surface_export','configure_gateways_commit','${token}')`, "commit");
		check(commit.gateways === 4 && commit.bytes === ascii.length,
			"commit echoes the true gateway count and byte size",
			`gateways=${commit.gateways} bytes=${commit.bytes} expected 4/${ascii.length}`);

		const stored = lua(
			"local g = storage.surface_export_config and storage.surface_export_config.gateways or {} "
			+ "local n = 0 for _ in pairs(g) do n = n + 1 end "
			+ "local t1 = g['surfexp_gateway_1'] and g['surfexp_gateway_1'].targets "
			+ "return { ok = true, count = n, first_name = t1 and t1[1] and t1[1].instanceName, "
			+ "first_targets = t1 and #t1 }");
		check(stored.count === 4, "storage: all four gateway keys present", `count=${stored.count}`);
		check(stored.first_targets === 60, "storage: target list survives whole", `targets=${stored.first_targets}`);
		check(stored.first_name === keyed.surfexp_gateway_1.targets[0].instanceName,
			"storage: the non-ASCII long instanceName decoded byte-identical",
			`got ${JSON.stringify(stored.first_name)}`);

		const token2 = `gwtest2_${Date.now().toString(36)}`;
		remoteCall(`remote.call('surface_export','configure_gateways_begin','${token2}',2,'${checksum}')`,
			"begin (failure probes)");
		remoteCall(`remote.call('surface_export','configure_gateways_chunk','${token2}',1,${bracketWrap(chunks[0])})`,
			"probe chunk");
		expectRefusal(`remote.call('surface_export','configure_gateways_chunk','wrong-token',2,${bracketWrap(chunks[1])})`,
			"a wrong token is refused", /superseded|no staging/);
		expectRefusal(`remote.call('surface_export','configure_gateways_chunk','${token2}',1,${bracketWrap(chunks[1])})`,
			"a duplicate index is refused", /already received/);
		expectRefusal(`remote.call('surface_export','configure_gateways_commit','${token2}')`,
			"an incomplete commit is refused", /incomplete/);
		const slotAfter = lua("return { ok = true, empty = storage.surface_export_gateway_staging == nil }");
		check(slotAfter.empty === true,
			"a refused commit clears the staging slot (no residue)", JSON.stringify(slotAfter));

		const small = remoteCall(
			`remote.call('surface_export','configure_gateways',${bracketWrap('{"surfexp_gateway_1":{"targets":[]}}')})`,
			"single-shot fast path");
		check(small.gateways === 1, "single-shot path applies and echoes", JSON.stringify(small));
	} finally {
		const restored = lua(
			`local ok_restore = pcall(function() `
			+ `remote.call('surface_export','configure_gateways',${bracketWrap(snapshot.gateways)}) end) `
			+ "storage.surface_export_gateway_staging = nil "
			+ "return { ok = true, restored = ok_restore }");
		console.log(`  cleanup: real gateway config restored=${restored.restored}, staging slot nil`);
		if (restored.restored !== true) {
			failed++;
			console.error("  FAIL cleanup could not restore the snapshotted gateway config — restore by hand from the controller Save");
		}
		const echo = lua(
			"return { ok = true, gateways = helpers.table_to_json(storage.surface_export_config "
			+ "and storage.surface_export_config.gateways or {}) }");
		const sortedStringify = (value) => {
			if (Array.isArray(value)) return `[${value.map(sortedStringify).join(",")}]`;
			if (value && typeof value === "object") {
				return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${sortedStringify(value[k])}`).join(",")}}`;
			}
			return JSON.stringify(value);
		};
		const same = sortedStringify(JSON.parse(echo.gateways)) === sortedStringify(JSON.parse(snapshot.gateways));
		check(same, "cleanup: restored config deep-equals the snapshot key-order-independently (zero leftover)");
	}

	if (failed) {
		console.log(`=== gateway-config-chunking: ${failed} FAILURE(S) ===`);
		process.exit(1);
	}
	console.log("=== gateway-config-chunking: ALL PASS ===");
}

main().catch(error => {
	console.error(`gateway-config-chunking: fatal — ${error && error.stack ? error.stack : error}`);
	process.exit(1);
});
