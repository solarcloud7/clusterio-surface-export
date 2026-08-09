#!/usr/bin/env node
// canvas-locking — the padlock stops edge deletion, and no edge renders the fallback blue.
// requires: a live cluster (controller on localhost:8080) with >= 2 instances, built dist/web
// produces: PASS/FAIL per check on stdout; exit 1 on any failure
// does not: save anything to the controller (it stages its own link and reverts), assert edge
//           geometry, or prove the lock survives a reload — it is deliberately per-session UI state

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

import { assertPageMatchesDisk } from "../../../tools/surface-export/canvas-bundle.mjs";

const CONTROLLER_CONTAINER = "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";
const BASE_URL = process.env.SE_WEB_URL || "http://localhost:8080";
const CANVAS_URL = `${BASE_URL}/surface-export?tab=gateways`;

const COLOURS_SRC = new URL(
	"../../../docker/seed-data/external_plugins/surface_export/web/gateway/gateway-colours.ts",
	import.meta.url,
);

function fallbackEdgeColour() {
	const source = readFileSync(COLOURS_SRC, "utf8");
	const hex = source.match(/DEFAULT_EDGE_COLOUR\s*=\s*"(#[0-9a-fA-F]{6})"/)?.[1];
	if (!hex) {
		throw new Error(`could not read DEFAULT_EDGE_COLOUR from ${COLOURS_SRC.pathname} — a hand-copied `
			+ "colour that drifts from the constant fails OPEN, so this refuses to guess");
	}
	return `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
}

const FALLBACK_BLUE = fallbackEdgeColour();

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

async function centreOf(locator) {
	const box = await locator.boundingBox();
	if (!box) {
		throw new Error("element has no layout box");
	}
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

console.log("=== canvas-locking: the padlock gates edge deletion, edges never fall back to blue ===");

const browser = await chromium.launch();
try {
	const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
	const page = await context.newPage();
	page.on("pageerror", err => console.log(`  [page error] ${err.message}`));

	let lastLoadError = null;
	const load = async (url) => {
		for (let attempt = 0; attempt < 15; attempt += 1) {
			try {
				await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });
				return true;
			} catch (err) {
				lastLoadError = err;
				await page.waitForTimeout(1000);
			}
		}
		return false;
	};
	const loadFailure = (url) => new Error(
		`could not load ${url} after 15 attempts: ${lastLoadError?.message?.split("\n")[0] || "no error recorded"}`,
	);

	if (!await load(BASE_URL)) {
		throw loadFailure(BASE_URL);
	}
	await page.evaluate(value => window.localStorage.setItem("controller_token", value), adminToken());
	if (!await load(CANVAS_URL)) {
		throw loadFailure(CANVAS_URL);
	}

	const nodes = page.locator(".react-flow__node-instance");
	await nodes.first().waitFor({ state: "visible", timeout: 30000 });
	const bundle = await assertPageMatchesDisk(page, { context: "canvas-locking" });
	check(true, `page is running the build on disk (${bundle})`);

	await page.waitForTimeout(2500);

	const lock = page.locator('[data-testid="canvas-lock"]');
	check(await lock.count() === 1, "the canvas owns its padlock");
	check(
		await page.locator(".react-flow__controls-interactive").count() === 0,
		"React Flow's own padlock is gone — it toggled state nothing read",
	);

	const edges = page.locator(".react-flow__edge-path");
	const panelText = async () => (await page.locator(".react-flow__panel.top.right").innerText()).trim();
	const clickEdge = async () => {
		await edges.first().dispatchEvent("click");
		await page.waitForTimeout(500);
	};

	// A fresh cluster has no saved gateway link, so the subject is staged here rather than assumed.
	// Staged and saved links are both real edges on the canvas and both route through onEdgeClick,
	// which is what this test is about.
	if (!await edges.count()) {
		const nodeCount = await nodes.count();
		if (nodeCount < 2) {
			throw new Error(`need 2 instances to stage a link, found ${nodeCount}`);
		}
		const from = await centreOf(nodes.nth(0).locator(".surface-export-gw-cover").first());
		const to = await centreOf(nodes.nth(1).locator(".surface-export-gw-cover").first());
		await page.mouse.move(from.x, from.y);
		await page.mouse.down();
		for (let step = 1; step <= 8; step += 1) {
			await page.mouse.move(from.x + (to.x - from.x) * step / 8, from.y + (to.y - from.y) * step / 8);
			await page.waitForTimeout(20);
		}
		await page.mouse.up();
		await page.waitForTimeout(800);
	}
	const edgeCount = await edges.count();
	check(edgeCount >= 1, "there is a gateway link on the canvas to act on", `found ${edgeCount}`);
	if (!edgeCount) {
		throw new Error("could not obtain a gateway edge — neither configured nor stageable");
	}

	// Markers render once into a shared <defs> and edges reference them by url(#id), so the first
	// marker in the document need not belong to the first edge — with two links on different
	// gateways that pairing is simply wrong.
	const colours = await page.evaluate(() => {
		const path = document.querySelector(".react-flow__edge-path");
		const ref = path?.getAttribute("marker-end") || path?.getAttribute("marker-start");
		const id = ref?.match(/url\(["']?#(.+?)["']?\)/)?.[1];
		const shape = id && document.querySelector(`#${CSS.escape(id)} polyline, #${CSS.escape(id)} path`);
		return {
			markerRef: id || null,
			edge: path ? getComputedStyle(path).stroke : null,
			arrow: shape ? getComputedStyle(shape).fill : null,
		};
	});
	check(
		Boolean(colours.markerRef),
		"the edge references a marker by id (control arm for the colour check below)",
		`marker-end/-start was ${colours.markerRef === null ? "absent" : colours.markerRef}`,
	);
	check(
		Boolean(colours.arrow) && colours.arrow === colours.edge,
		"that edge's own arrowhead is drawn in its colour, not React Flow's grey default",
		`edge ${colours.edge}, arrow ${colours.arrow}`,
	);

	// The panel text is the observable, whichever way it moves: disconnecting a SAVED link adds
	// pending changes, disconnecting a STAGED one removes them. Both are "the click did something".
	const baseline = await panelText();

	await lock.click();
	await page.waitForTimeout(300);
	check(await lock.getAttribute("data-locked") === "true", "clicking the padlock locks the canvas");

	await clickEdge();
	const whileLocked = await panelText();
	check(
		whileLocked === baseline,
		"clicking an edge while LOCKED changes nothing",
		`panel went from "${baseline}" to "${whileLocked}"`,
	);

	// Control arm. Without it the check above would pass just as well on a canvas where clicking an
	// edge never does anything. Locked runs first so the edge still exists for this step.
	await lock.click();
	await page.waitForTimeout(300);
	await clickEdge();
	const whileUnlocked = await panelText();
	check(
		whileUnlocked !== baseline,
		"the same click UNLOCKED does change the staged state",
		`panel still reads "${whileUnlocked}"`,
	);

	const revert = page.locator(".react-flow__panel.top.right button", { hasText: /revert/i });
	if (await revert.count()) {
		await revert.first().click();
		await page.waitForTimeout(500);
	}
	check(!/unsaved change/.test(await panelText()), "nothing was left staged, nothing saved");

	const edgesBeforeShips = await edges.count();
	await page.evaluate(() => window.surfaceExportCanvas?.ships?.());
	await page.waitForTimeout(1200);
	const edgesAfterShips = await edges.count();
	check(
		edgesAfterShips > edgesBeforeShips,
		"ships() actually drew ship edges (control arm)",
		`${edgesBeforeShips} edges before, ${edgesAfterShips} after — with no new edge the colour `
		+ "check below measures the same set that already existed",
	);
	const strokes = await page.evaluate(() => [...document.querySelectorAll(".react-flow__edge-path")]
		.map(p => getComputedStyle(p).stroke));
	check(
		strokes.length > 0 && !strokes.includes(FALLBACK_BLUE),
		`no edge falls back to DEFAULT_EDGE_COLOUR ${FALLBACK_BLUE} once ship edges are drawn`,
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
