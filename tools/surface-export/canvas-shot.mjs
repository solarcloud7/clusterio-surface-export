#!/usr/bin/env node
/**
 * Photograph the gateway canvas in any state, headlessly.
 *
 * THE GAP THIS CLOSES. The canvas could be DRIVEN (`window.surfaceExportCanvas`) and one behaviour
 * could be REGRESSED (tests/integration/canvas-drag), but there was no way to LOOK at it without a
 * human displaying a browser pane — and a pane that stops compositing does not fail loudly, it
 * silently returns wrong geometry. Every canvas measurement this session that turned out to be a
 * false finding traced back to reading a page nobody could see.
 *
 * This drives the same console API the browser offers, then saves a PNG. No pane, no human.
 *
 * REQUIRES A LIVE CLUSTER: it loads the real controller UI at localhost:8080.
 *
 *   node tools/surface-export/canvas-shot.mjs                       # the live cluster as-is
 *   node tools/surface-export/canvas-shot.mjs --mocks 6 --geometry  # 6 fake instances + overlay
 *   node tools/surface-export/canvas-shot.mjs --ships               # one ship per transfer phase
 *   node tools/surface-export/canvas-shot.mjs --replay 3            # the 3 most recent REAL transfers
 *   node tools/surface-export/canvas-shot.mjs --scenario hub        # a built-in shape (see SCENARIOS)
 *   node tools/surface-export/canvas-shot.mjs --scenario ./my.json  # or your own scenario file
 *   node tools/surface-export/canvas-shot.mjs --out /tmp/canvas.png --list-transfers
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const CONTROLLER_CONTAINER = "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";
const BASE_URL = process.env.SE_WEB_URL || "http://localhost:8080";

/**
 * Shapes worth having on tap. Deliberately few: the point of the scenario format is that you write
 * your own, and a library of twenty presets would rot. These are the ones that recur — a topology
 * the dev cluster cannot make, and the two list edge cases.
 */
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
	// The platform list's two boundaries in one picture: an instance past the six-row cap (so the
	// "+k more" line is drawn) beside one with nothing at all.
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

/** The controller's own admin token, read in-process. Never printed; dies with the browser. */
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
	// Anything that is not a built-in name is treated as a path, so `--scenario ./mine.json` works
	// without a second flag. A typo'd built-in name therefore fails as a missing file, which names
	// both possibilities in one message.
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
	console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*?|^ \* ?/gm, "").trim());
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

	// Seed the token the way a person does — load the origin, write it, load the page. An init script
	// would also run on about:blank, where localStorage throws.
	await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
	await page.evaluate(value => window.localStorage.setItem("controller_token", value), adminToken());
	await page.goto(`${BASE_URL}/surface-export?tab=gateways`, { waitUntil: "domcontentloaded" });

	await page.waitForFunction(() => Boolean(window.surfaceExportCanvas), null, { timeout: 30000 });
	await page.locator(".react-flow__node-instance").first().waitFor({ state: "visible", timeout: 30000 });
	// The platform tree arrives over the websocket after the first render; without this the shot can
	// catch instances with no platforms and read as a bug in the platform list.
	await page.waitForTimeout(2500);

	if (args.listTransfers) {
		const listing = await page.evaluate(() => window.surfaceExportCanvas.transfers(50));
		console.log(`${listing.drawable} drawable transfer(s); newest ${listing.showing}:`);
		for (const row of listing.transfers) {
			console.log(`  ${row.status.padEnd(20)} ${row.sourceInstanceId} -> ${row.targetInstanceId}  ${row.platformName ?? ""}  ${row.transferId}`);
		}
	}

	// Applied in the order a person would: shape first, then what rides on it.
	const applied = await page.evaluate(async (options) => {
		const api = window.surfaceExportCanvas;
		if (options.scenario) { await api.load(options.scenario); }
		if (options.mocks !== undefined) { await api.mocks(options.mocks, options.platforms ?? 3); }
		if (options.ships) { await api.ships(); }
		if (options.replay) { await api.replay(options.replay); }
		if (options.geometry) { await api.geometry(true); }
		if (!options.scenario && options.mocks === undefined && !options.ships && !options.replay && !options.geometry) {
			// Nothing asked for: photograph the live cluster untouched rather than turning debug on.
			return api.describe();
		}
		return api.describe();
	}, { scenario, mocks: args.mocks, platforms: args.platforms, ships: args.ships, replay: args.replay, geometry: args.geometry });

	// FRAME IT, and do it HERE rather than relying on the app.
	//
	// The canvas deliberately does not re-fit when a scenario loads: React Flow needs the new nodes
	// MEASURED before it can compute a zoom, and at load time they are not, so an in-app re-fit
	// translates the viewport without ever zooming out — measured, scale stayed 1 while the fit
	// control pressed two seconds later gave 0.543. A half-working re-fit is worse than none, so the
	// app leaves it alone and a photograph — which can afford to wait — does it properly.
	//
	// Pressing the control React Flow already renders, rather than reaching for the instance: it is
	// the same code path a person uses, and there is no second answer to keep in step.
	await page.waitForTimeout(600);
	await page.locator(".react-flow__controls-fitview").click();
	// Let the fit animation and any ship transition settle, or the shot catches things mid-flight.
	await page.waitForTimeout(1200);

	const target = path.resolve(args.out);
	await page.locator(".surface-export-canvas").screenshot({ path: target });
	console.log(`canvas: ${JSON.stringify(applied)}`);
	console.log(`saved:  ${target}`);
} finally {
	await browser.close();
}
