#!/usr/bin/env node
// canvas-shot — screenshot the gateway canvas in a chosen state.
// requires: live cluster (controller on localhost:8080), built dist/web, playwright chromium
// produces: PNG at --out; stdout: the canvas state photographed, as JSON
// does not: assert anything, verify layout, or establish that the page is correct

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const CONTROLLER_CONTAINER = "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";
const BASE_URL = process.env.SE_WEB_URL || "http://localhost:8080";

const SCENARIOS = {
	hub: {
		instances: [
			{ name: "hub", platforms: ["alpha", "beta", "gamma"] },
			{ name: "spoke-1", platforms: ["delta"] },
			{ name: "spoke-2", platforms: [] },
			{ name: "spoke-3", online: false, platforms: ["epsilon"] },
		],
		links: [[0, 1], [0, 2], [0, 3]],
		ships: [{ from: 0, to: 1, status: "awaiting_validation" }, { from: 3, to: 0, status: "failed" }],
	},
	chain: {
		instances: [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }],
		links: [[0, 1], [1, 2], [2, 3]],
	},
	"list-edges": {
		instances: [
			{ name: "twelve", platforms: Array.from({ length: 12 }, (_, i) => `pad-${i + 1}`) },
			{ name: "empty", platforms: [] },
		],
		links: [[0, 1]],
	},
};

function parseArgs(argv) {
	const args = { out: "canvas.png" };
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		const next = () => argv[++i];
		switch (flag) {
			case "--out": args.out = next(); break;
			case "--scenario": args.scenario = next(); break;
			case "--mocks": args.mocks = Number(next()); break;
			case "--platforms": args.platforms = Number(next()); break;
			case "--ships": args.ships = true; break;
			case "--replay": args.replay = Number(next() ?? 3); break;
			case "--geometry": args.geometry = true; break;
			case "--list-transfers": args.listTransfers = true; break;
			case "--width": args.width = Number(next()); break;
			case "--height": args.height = Number(next()); break;
			case "--help": case "-h": args.help = true; break;
			default:
				throw new Error(`unknown flag ${flag} — run with --help`);
		}
	}
	return args;
}

function adminToken() {
	const raw = execFileSync("docker", ["exec", CONTROLLER_CONTAINER, "cat", CTL_CONFIG], { encoding: "utf8" });
	const token = JSON.parse(raw)["control.controller_token"];
	if (!token) {
		throw new Error(`no control.controller_token in ${CTL_CONFIG} — is the controller running?`);
	}
	return token;
}

function resolveScenario(name) {
	if (!name) {
		return null;
	}
	if (SCENARIOS[name]) {
		return SCENARIOS[name];
	}
	try {
		return JSON.parse(readFileSync(path.resolve(name), "utf8"));
	} catch (err) {
		throw new Error(
			`--scenario "${name}" is neither a built-in (${Object.keys(SCENARIOS).join(", ")}) `
			+ `nor a readable JSON file: ${err.message}`,
		);
	}
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
	console.log([
		"canvas-shot — screenshot the gateway canvas. Requires a live cluster.",
		"",
		"  --out <path>            output PNG (default canvas.png)",
		"  --scenario <name|file>  built-in (" + Object.keys(SCENARIOS).join(", ") + ") or a JSON file",
		"  --mocks <n>             fake instances appended to the live cluster",
		"  --platforms <n>         fake platforms per mock instance",
		"  --ships                 one fake ship per transfer phase",
		"  --replay <n>            the n most recent REAL transfers, as ships",
		"  --geometry              outline the measured node box, portal and edge anchor",
		"  --list-transfers        print the real transfers this page can draw",
		"  --width / --height      viewport size (default 1600x1000)",
	].join("\n"));
	process.exit(0);
}

const scenario = resolveScenario(args.scenario);
const browser = await chromium.launch();
try {
	const context = await browser.newContext({
		viewport: { width: args.width || 1600, height: args.height || 1000 },
	});
	const page = await context.newPage();
	page.on("pageerror", err => console.log(`  [page error] ${err.message}`));

	await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
	await page.evaluate(value => window.localStorage.setItem("controller_token", value), adminToken());
	await page.goto(`${BASE_URL}/surface-export?tab=gateways`, { waitUntil: "domcontentloaded" });

	await page.waitForFunction(() => Boolean(window.surfaceExportCanvas), null, { timeout: 30000 });
	await page.locator(".react-flow__node-instance").first().waitFor({ state: "visible", timeout: 30000 });
	await page.waitForTimeout(2500);

	if (args.listTransfers) {
		const listing = await page.evaluate(() => window.surfaceExportCanvas.transfers(50));
		console.log(`${listing.drawable} drawable transfer(s); newest ${listing.showing}:`);
		for (const row of listing.transfers) {
			console.log(`  ${row.status.padEnd(20)} ${row.sourceInstanceId} -> ${row.targetInstanceId}  ${row.platformName ?? ""}  ${row.transferId}`);
		}
	}

	const applied = await page.evaluate(async (options) => {
		const api = window.surfaceExportCanvas;
		if (options.scenario) { await api.load(options.scenario); }
		if (options.mocks !== undefined) { await api.mocks(options.mocks, options.platforms ?? 3); }
		if (options.ships) { await api.ships(); }
		if (options.replay) { await api.replay(options.replay); }
		if (options.geometry) { await api.geometry(true); }
		if (!options.scenario && options.mocks === undefined && !options.ships && !options.replay && !options.geometry) {
			return api.describe();
		}
		return api.describe();
	}, { scenario, mocks: args.mocks, platforms: args.platforms, ships: args.ships, replay: args.replay, geometry: args.geometry });

	await page.waitForTimeout(600);
	await page.locator(".react-flow__controls-fitview").click();
	await page.waitForTimeout(1200);

	const target = path.resolve(args.out);
	await page.locator(".surface-export-canvas").screenshot({ path: target });
	console.log(`canvas: ${JSON.stringify(applied)}`);
	console.log(`saved:  ${target}`);
} finally {
	await browser.close();
}
