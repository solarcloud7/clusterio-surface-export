#!/usr/bin/env node
// canvas-locking — the padlock stops edge deletion, and no edge renders the fallback blue.
// requires: a live cluster (controller on localhost:8080) with >= 1 configured gateway link, built dist/web
// produces: PASS/FAIL per check on stdout; exit 1 on any failure
// does not: save anything to the controller (every staged change is reverted), assert edge geometry,
//           or prove the lock survives a reload — it is deliberately per-session UI state

import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

import { assertPageMatchesDisk } from "../../../tools/surface-export/canvas-bundle.mjs";

const CONTROLLER_CONTAINER = "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";
const BASE_URL = process.env.SE_WEB_URL || "http://localhost:8080";
const CANVAS_URL = `${BASE_URL}/surface-export?tab=gateways`;
const FALLBACK_BLUE = "rgb(22, 102, 220)";

let failed = 0;
const check = (ok, label, detail = "") => {
	console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) { failed += 1; }
};

function adminToken() {
	const raw = execFileSync("docker", ["exec", CONTROLLER_CONTAINER, "cat", CTL_CONFIG], { encoding: "utf8" });
	const token = JSON.parse(raw)["control.controller_token"];
	if (!token || typeof token !== "string") {
		throw new Error(`no control.controller_token in ${CTL_CONFIG} — is the controller running?`);
	}
	return token;
}

console.log("=== canvas-locking: the padlock gates edge deletion, edges never fall back to blue ===");

const browser = await chromium.launch();
try {
	const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
	const page = await context.newPage();
	page.on("pageerror", err => console.log(`  [page error] ${err.message}`));

	const load = async (url) => {
		for (let attempt = 0; attempt < 15; attempt += 1) {
			try {
				await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });
				return true;
			} catch {
				await page.waitForTimeout(1000);
			}
		}
		return false;
	};

	if (!await load(BASE_URL)) {
		throw new Error(`could not load ${BASE_URL} — is the controller running?`);
	}
	await page.evaluate(value => window.localStorage.setItem("controller_token", value), adminToken());
	if (!await load(CANVAS_URL)) {
		throw new Error(`could not load ${CANVAS_URL}`);
	}

	await page.locator(".react-flow__node-instance").first().waitFor({ state: "visible", timeout: 30000 });
	const bundle = await assertPageMatchesDisk(page, { context: "canvas-locking" });
	check(true, `page is running the build on disk (${bundle})`);

	await page.waitForTimeout(2500);

	const edges = page.locator(".react-flow__edge-path");
	const edgeCount = await edges.count();
	check(edgeCount >= 1, "the canvas has a configured gateway link to act on", `found ${edgeCount}`);
	if (!edgeCount) {
		throw new Error("no gateway link on the canvas — link two instances before running this test");
	}

	const lock = page.locator('[data-testid="canvas-lock"]');
	check(await lock.count() === 1, "the canvas owns its padlock");
	check(
		await page.locator(".react-flow__controls-interactive").count() === 0,
		"React Flow's own padlock is gone — it toggled state nothing read",
	);

	const panelText = () => page.locator(".react-flow__panel.top.right").innerText();
	const clickEdge = async () => {
		await edges.first().dispatchEvent("click");
		await page.waitForTimeout(500);
	};

	const revert = page.locator(".react-flow__panel.top.right button", { hasText: /revert/i });
	const revertAll = async () => {
		if (await revert.count()) {
			await revert.first().click();
			await page.waitForTimeout(500);
		}
	};

	const before = (await panelText()).trim();
	check(!/unsaved change/.test(before), "starts with nothing staged", `panel reads "${before}"`);

	// The control arm runs FIRST: unless this click is known to stage something, the locked check
	// below would pass just as well against a canvas where clicking an edge never does anything.
	// It also has to run first because a click that DOES delete removes the edge from the DOM.
	await clickEdge();
	const whileUnlocked = (await panelText()).trim();
	check(
		/unsaved change/.test(whileUnlocked),
		"clicking an edge while UNLOCKED stages a change (control arm)",
		`panel reads "${whileUnlocked}"`,
	);

	await revertAll();
	check(!/unsaved change/.test((await panelText()).trim()), "revert restores the edge and clears staging");

	await lock.click();
	await page.waitForTimeout(300);
	check(await lock.getAttribute("data-locked") === "true", "clicking the padlock locks the canvas");

	await clickEdge();
	const whileLocked = (await panelText()).trim();
	check(
		!/unsaved change/.test(whileLocked),
		"the same click while LOCKED stages nothing",
		`panel reads "${whileLocked}"`,
	);

	await lock.click();
	await page.waitForTimeout(300);
	await revertAll();
	check(!/unsaved change/.test((await panelText()).trim()), "nothing was left staged, nothing saved");

	const colours = await page.evaluate(() => {
		const path = document.querySelector(".react-flow__edge-path");
		const marker = document.querySelector("marker.react-flow__arrowhead polyline, marker.react-flow__arrowhead path");
		return {
			edge: path ? getComputedStyle(path).stroke : null,
			arrow: marker ? getComputedStyle(marker).fill : null,
		};
	});
	check(
		colours.arrow === colours.edge,
		"arrowheads are drawn in their edge's colour, not React Flow's grey default",
		`edge ${colours.edge}, arrow ${colours.arrow}`,
	);

	await page.evaluate(() => window.surfaceExportCanvas?.ships?.());
	await page.waitForTimeout(1200);
	const strokes = await page.evaluate(() => [...document.querySelectorAll(".react-flow__edge-path")]
		.map(p => getComputedStyle(p).stroke));
	check(
		strokes.length > 0 && !strokes.includes(FALLBACK_BLUE),
		"no edge falls back to DEFAULT_EDGE_COLOUR once ship edges are drawn",
		`strokes: ${[...new Set(strokes)].join(", ")}`,
	);
} catch (err) {
	console.log(`  FAIL harness error — ${err && err.message ? err.message : err}`);
	failed += 1;
} finally {
	await browser.close();
}

if (failed) {
	console.log(`\n=== canvas-locking: ${failed} FAILURE(S) ===`);
	process.exit(1);
}
console.log("\n=== canvas-locking: all checks passed ===");
process.exit(0);
