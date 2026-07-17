const { readFileSync } = require("node:fs");
const { Rcon } = require("/clusterio/node_modules/rcon-client");

const [port, password, runtimePath, requestBase64] = process.argv.slice(2);

async function main() {
	const runtime = readFileSync(runtimePath, "utf8");
	const requestJson = Buffer.from(requestBase64, "base64").toString("utf8");
	if (requestJson.includes("]=]")) throw new Error("request contains unsafe Lua long-string delimiter");
	const command = `/c local request=helpers.json_to_table([=[${requestJson}]=]); local ok,result=pcall(function() ${runtime} end); if ok then rcon.print(helpers.table_to_json(result)) else rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) end`;
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
