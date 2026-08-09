#!/usr/bin/env node

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

const CONTAINER = "surface-export-controller";
const TOKEN_PATH = "/clusterio/tokens/config-control.json";
const TOKEN_KEY = "control.controller_token";

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const origin = arg("origin", "http://localhost:8080");
const timeoutS = Number(arg("timeout", "60"));
if (!Number.isFinite(timeoutS) || timeoutS <= 0 || timeoutS > 600) {
	console.error("--timeout must be a positive number of seconds, <= 600");
	process.exit(2);
}

let token;
try {
	const raw = execFileSync("docker", ["exec", CONTAINER, "cat", TOKEN_PATH],
		{ encoding: "utf8", timeout: 30_000 });
	const parsed = JSON.parse(raw);
	token = parsed[TOKEN_KEY];
} catch (err) {
	console.error(`Could not read the admin token from ${CONTAINER}:${TOKEN_PATH} — ${err.message}`);
	console.error("Is the cluster up? (docker ps --filter name=surface-export)");
	process.exit(1);
}
if (typeof token !== "string" || token.length === 0) {
	console.error(`${TOKEN_PATH} has no usable "${TOKEN_KEY}" — refusing to serve an empty token.`);
	process.exit(1);
}

const nonce = randomBytes(16).toString("hex");
let served = false;

const server = createServer((req, res) => {
	if (req.method === "OPTIONS") {
		res.writeHead(204, {
			"Access-Control-Allow-Origin": origin,
			"Access-Control-Allow-Methods": "GET, OPTIONS",
			"Access-Control-Max-Age": "60",
		});
		res.end();
		return;
	}

	if (req.method !== "GET" || req.url !== `/${nonce}`) {
		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end("not found\n");
		return;
	}

	if (served) {
		res.writeHead(410, { "Content-Type": "text/plain" });
		res.end("already served\n");
		return;
	}
	served = true;

	res.writeHead(200, {
		"Content-Type": "text/plain",
		"Access-Control-Allow-Origin": origin,
		"Cache-Control": "no-store",
	});
	res.end(token);

	res.on("finish", () => {
		console.error(`served token (${token.length} chars) to ${origin} — shutting down`);
		clearTimeout(deadline);
		server.close(() => process.exit(0));
	});
});

const deadline = setTimeout(() => {
	console.error(`timed out after ${timeoutS}s without being fetched — shutting down`);
	server.close(() => process.exit(3));
}, timeoutS * 1000);

server.listen(0, "127.0.0.1", () => {
	const { port } = server.address();
	console.log(`http://127.0.0.1:${port}/${nonce}`);
	console.error(`one-shot token relay listening on 127.0.0.1:${port}, expires in ${timeoutS}s`);
});
