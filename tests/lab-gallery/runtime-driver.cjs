const { readFileSync } = require("node:fs");
const { Rcon } = require("/clusterio/node_modules/rcon-client");

// argv: <port> <password> <luaFile...> <requestBase64>. Every Lua file except the last is a PRELUDE
// injected ahead of the runtime as `local FixtureMeters = (function() ... end)()` (the shared
// fixture-meters library); the last Lua file is the runtime the request dispatches against. A bare
// single-file invocation (no prelude) stays backward-compatible.
const argv = process.argv.slice(2);
const [port, password] = argv;
const requestBase64 = argv[argv.length - 1];
const luaPaths = argv.slice(2, argv.length - 1);
const runtimePath = luaPaths[luaPaths.length - 1];
const preludePaths = luaPaths.slice(0, -1);

// Strip \r (CRLF) and reject the long-string delimiter on EVERY shipped file — a commented meters
// library is now shipped over RCON, so the guard must cover the preludes too, not just the request.
function readLua(path) {
	const text = readFileSync(path, "utf8").replace(/\r/g, "");
	if (text.includes("]=]")) throw new Error(`Lua file ${path} contains unsafe long-string delimiter ]=]`);
	return text;
}

async function main() {
	const preludes = preludePaths.map(readLua).map(text => `local FixtureMeters=(function() ${text} end)() `).join("");
	const runtime = readLua(runtimePath);
	const requestJson = Buffer.from(requestBase64, "base64").toString("utf8");
	if (requestJson.includes("]=]")) throw new Error("request contains unsafe Lua long-string delimiter");
	const command = `/c local request=helpers.json_to_table([=[${requestJson}]=]); ${preludes}local ok,result=pcall(function() ${runtime} end); if ok then rcon.print(helpers.table_to_json(result)) else rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) end`;
	const rcon = await Rcon.connect({ host: "127.0.0.1", port: Number(port), password, timeout: 15_000 });
	try {
		const response = await rcon.send(command);
		const result = JSON.parse(response.trim().split(/\r?\n/).filter(Boolean).at(-1));
		if (result.success !== true) throw new Error(result.error || "gallery runtime operation failed");
		console.log(JSON.stringify(result));
	} finally {
		try { rcon.end(); } catch { /* The game can close the socket while a surface deletion settles. */ }
	}
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
