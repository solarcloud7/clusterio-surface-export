#!/usr/bin/env node
// One-shot loopback relay that hands the dev cluster's admin token straight to a browser session.
//
// WHY THIS EXISTS
// ---------------
// The web UI is token-only (no cookie, no anonymous mode): the SPA reads
// localStorage["controller_token"] on boot, and there is no query-param auth path — see
// @clusterio/web_ui App.tsx. To drive the UI in an automated session, something has to put the
// token in localStorage.
//
// The obvious way — read the token, then paste it into a browser-eval call — means the token value
// passes through the automation's own conversation and lands in a transcript. That is the thing
// worth avoiding, and it is avoidable: this relay hands the token DIRECTLY to the page, so the
// automation only ever writes the plumbing (a fetch URL) and can verify success by LENGTH rather
// than by value. Nothing that handles the token ever prints it.
//
// This is the same shape as a password manager filling a form: the secret goes from its source to
// its destination without a detour through whoever asked for it.
//
// WHAT IT EXPOSES, HONESTLY
// -------------------------
// For a short window, any process on this machine that can reach the loopback interface AND guess
// the nonce path can read the token. Mitigations, in order of importance:
//   * binds 127.0.0.1 only — never a routable interface
//   * single-use: the server closes the moment it serves the token once
//   * expires on its own (default 60s) whether or not it is used
//   * random 32-hex-char nonce path; a bare GET / gets 404 and does NOT extend the window
//   * CORS is pinned to the one origin that should be asking
// This is proportionate for a disposable localhost dev cluster with a short-lived, self-minted
// token. It is NOT a pattern for anything reachable from outside the machine, and the token source
// below is deliberately the dev cluster's container — there is no flag to point it elsewhere.
//
// USAGE
//   node tools/clusterio/serve-admin-token.mjs [--origin http://localhost:8080] [--timeout 60]
// Prints ONE line: the URL to fetch. Then, in the page at <origin>:
//   const t = await (await fetch("<url>")).text();
//   localStorage.setItem("controller_token", t);
// then reload. Verify with t.length, never by printing t.

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

// Read the token from the same place tools/clusterio/get-admin-token.ps1 reads it. Any failure here
// is fatal and loud: a relay that silently serves an empty string would present as "logged in but
// nothing loads", which is a much worse thing to debug than a missing container.
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
	// Preflight: the page's fetch is cross-origin (different port), so the browser may ask first.
	if (req.method === "OPTIONS") {
		res.writeHead(204, {
			"Access-Control-Allow-Origin": origin,
			"Access-Control-Allow-Methods": "GET, OPTIONS",
			"Access-Control-Max-Age": "60",
		});
		res.end();
		return;
	}

	// Anything that is not the exact single-use path is a miss. Deliberately does NOT consume the
	// one shot and does NOT extend the deadline — a wrong guess must not keep the window open.
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

	// Close as soon as the response is flushed: the shorter this lives, the smaller the window.
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
	// stdout carries ONLY the URL, so a caller can consume it without scraping. The token is never
	// written to stdout or stderr by any path in this file.
	console.log(`http://127.0.0.1:${port}/${nonce}`);
	console.error(`one-shot token relay listening on 127.0.0.1:${port}, expires in ${timeoutS}s`);
});
