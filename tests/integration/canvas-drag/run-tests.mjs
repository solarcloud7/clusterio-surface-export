#!/usr/bin/env node
// Canvas drag — the ONE web-UI behaviour that only a real browser can check.
//
// WHY THIS EXISTS. Dragging a platform row onto another instance's gateway is how a transfer is
// started from the canvas, and it broke silently: the handle rendered, carried every React Flow
// marker, and `isValidConnection` permitted the pairing — but the press was refused before
// validation, because React Flow resolves the pressed handle through the node's cached
// `handleBounds` and only rebuilds that cache when it MEASURES the node. The platform list is
// absolutely positioned outside the node's box (so the node stays a 150px circle and edges keep
// meeting the portal), so mounting it never changes the node's size and the handles never entered
// the cache. Fixed with `useUpdateNodeInternals`; this is what keeps it fixed.
//
// It went unnoticed because the drag was verified once while the list was ALWAYS VISIBLE — present
// at measure time — and then the list became open-on-click and nobody re-ran the drag.
//
// WHY A REAL BROWSER, and not jsdom. Every canvas bug that has actually bitten is GEOMETRY: the
// measured node box, the portal hit-zone, and now handle bounds. jsdom has no layout engine and
// returns zeros from getBoundingClientRect, so a jsdom suite would go green on all three. This uses
// real mouse events at real coordinates, which is the only method that has produced a trustworthy
// answer about this behaviour.
//
// A NOTE ON HAND-ROLLED PROBES, since this replaces a pile of them. Driving this page with
// hand-dispatched events produced four wrong results in one session — dispatching on React Flow's
// outer wrapper (events bubble UP, so the inner handler never ran), hand-firing `mouseenter` (React
// derives enter/leave from delegated mouseover/mouseout and never sees it), sampling inside a
// re-armed timer, and using `pointerdown` where React Flow binds `mousedown`. Three of those looked
// like findings. That is the failure mode this file exists to end.
//
// REQUIRES A LIVE CLUSTER, like every runner in this directory: it drives the real controller UI at
// localhost:8080 against the real platform tree.

import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const CONTROLLER_CONTAINER = "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";
const BASE_URL = process.env.SE_WEB_URL || "http://localhost:8080";
const CANVAS_URL = `${BASE_URL}/surface-export?tab=gateways`;

let failed = 0;
const check = (ok, label, detail = "") => {
	console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) { failed += 1; }
};

/**
 * The controller's own admin token, read in-process.
 *
 * Never printed and never written anywhere: the web UI is token-only (localStorage
 * "controller_token"; no cookie, no anonymous mode), so an automated session has to carry one. It
 * goes straight into `addInitScript` and dies with the browser. `tools/clusterio/get-admin-token.ps1`
 * reads the same field for a human; `serve-admin-token.mjs` exists for the case where a token would
 * otherwise pass through a transcript, which is not this one.
 */
function adminToken() {
	const raw = execFileSync("docker", ["exec", CONTROLLER_CONTAINER, "cat", CTL_CONFIG], { encoding: "utf8" });
	const token = JSON.parse(raw)["control.controller_token"];
	if (!token || typeof token !== "string") {
		throw new Error(`no control.controller_token in ${CTL_CONFIG} — is the controller running?`);
	}
	return token;
}

/** Centre of an element in PAGE coordinates, for real mouse moves. */
async function centreOf(locator) {
	const box = await locator.boundingBox();
	if (!box) {
		throw new Error("element has no layout box");
	}
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * A real press-move-release, in several steps.
 *
 * Multiple `mouse.move` calls, not one: React Flow starts a connection on the first movement after
 * mousedown and needs to see the pointer travel. A single jump can land inside its drag threshold
 * and read as a click.
 */
async function dragBetween(page, from, to) {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	for (let step = 1; step <= 8; step += 1) {
		await page.mouse.move(from.x + (to.x - from.x) * step / 8, from.y + (to.y - from.y) * step / 8);
		await page.waitForTimeout(20);
	}
	await page.mouse.up();
}

console.log("=== canvas-drag: a platform row can be dragged onto another instance's gateway ===");

const browser = await chromium.launch();
let exitCode = 0;
try {
	const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
	const token = adminToken();
	// NO addInitScript. That runs on EVERY document including the initial `about:blank`, where
	// localStorage access throws SecurityError — which meant a try/catch, two alarming "Access is
	// denied" page errors per run, and a swallowed error the lint guard rightly objected to.
	//
	// Instead, seed the token the way a person does: load the origin once, write it, then load the
	// page. The first load renders unauthenticated and is thrown away; the app reads the token at
	// boot, so it has to be in place before the load that matters.

	const page = await context.newPage();
	// Surfaced, not swallowed: a page error here usually means the bundle failed to load, and the
	// symptom downstream would be a mystifying "element not found".
	page.on("pageerror", err => console.log(`  [page error] ${err.message}`));

	// Bounded retry on the NAVIGATION only. This runner is typically invoked straight after a deploy,
	// and a controller that has just restarted refuses connections for a second or two
	// (`net::ERR_EMPTY_RESPONSE` — observed). Waiting for the server to exist is a precondition, not
	// part of what is being tested; every assertion below is untouched by it. It still gives up, and
	// says what it could not reach.
	const navErrors = [];
	const load = async (url) => {
		for (let attempt = 0; attempt < 15; attempt += 1) {
			try {
				await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });
				return true;
			} catch (err) {
				navErrors.push(err && err.message ? err.message.split("\n")[0] : String(err));
				await page.waitForTimeout(1000);
			}
		}
		return false;
	};

	if (!await load(BASE_URL)) {
		throw new Error(`could not load ${BASE_URL} — is the controller running? errors: ${navErrors.join(" | ")}`);
	}
	await page.evaluate(value => window.localStorage.setItem("controller_token", value), token);
	if (!await load(CANVAS_URL)) {
		throw new Error(`could not load ${CANVAS_URL} — errors: ${navErrors.join(" | ")}`);
	}

	const nodes = page.locator(".react-flow__node-instance");
	await nodes.first().waitFor({ state: "visible", timeout: 30000 });
	const nodeCount = await nodes.count();
	check(nodeCount >= 2, "the canvas has at least two instances to drag between", `found ${nodeCount}`);
	if (nodeCount < 2) {
		throw new Error("cannot test a transfer drag with fewer than two instances");
	}

	// Identify the two nodes by name so the assertion can state WHICH instance was preselected —
	// "a dialog opened" is much weaker than "the dialog names the instance I dropped on".
	const sourceNode = nodes.nth(0);
	const targetNode = nodes.nth(1);
	const targetName = (await targetNode.locator(".surface-export-instance-node-name").innerText()).trim();

	// Open the source node's platform list. It is closed by default and hides itself again, which is
	// exactly the condition that broke the drag — so opening it here is part of the test, not setup.
	//
	// SETTLE FIRST, THEN ACT ONCE — and the ordering is the whole point.
	//
	// An earlier version retried the click for up to 20 seconds to survive a flake seen right after a
	// controller restart. That retry DESTROYED THE TEST: run against a deliberately broken build it
	// passed, because the platform tree re-pushes roughly once a second, each push re-measures the
	// node, and a re-measure is precisely what the missing `useUpdateNodeInternals` would have done.
	// The test was waiting for the defect to heal itself and calling that a pass. Caught only by
	// re-running the mutation check after the rewrite.
	//
	// So: wait for the tree BEFORE touching anything (a precondition, and time spent here cannot mask
	// the bug because the list is still closed), then open and drag IMMEDIATELY — inside the window a
	// person actually acts in. If the platform never shows up, fail and say so; do not retry into a
	// green.
	await page.waitForTimeout(2500);

	const handle = sourceNode.locator(".surface-export-platform-handle").first();
	await sourceNode.locator(".surface-export-instance-node").click();
	const listOpened = await handle.waitFor({ state: "visible", timeout: 2000 })
		.then(() => true)
		.catch(err => {
			console.log(`  [list did not open] ${err && err.message ? err.message.split("\n")[0] : err}`);
			return false;
		});
	check(listOpened, "clicking an instance opens its platform list",
		"no platform row appeared — did the platform tree arrive, and does this instance have a hub-bearing platform?");
	if (!listOpened) {
		throw new Error("no platform to drag: the source instance reported no hub-bearing platforms");
	}

	// Hover the list first: that freezes the auto-hide clock, so the drag is not racing a 3s timer.
	// A human does the same thing by moving the mouse toward the control they are aiming at.
	await handle.hover();

	const from = await centreOf(handle);
	const to = await centreOf(targetNode.locator(".surface-export-gw-cover").first());
	await dragBetween(page, from, to);

	// THE ASSERTION. The dialog must open AND name the instance that was dropped on — the preselected
	// destination is the entire point of the gesture, and a dialog with an empty destination would
	// mean the drop target was lost.
	const modal = page.locator(".ant-modal-wrap:not([style*='display: none']) .ant-modal");
	let modalVisible = true;
	let modalWaitError = "";
	try {
		await modal.waitFor({ state: "visible", timeout: 5000 });
	} catch (err) {
		modalVisible = false;
		// Kept and reported: when this fails it IS the regression, and the reason the wait ended is
		// the whole diagnostic — a timeout means no dialog, anything else means the page broke.
		modalWaitError = err && err.message ? err.message.split("\n")[0] : String(err);
	}
	check(modalVisible, "dragging a platform onto another instance's gateway opens the Transfer dialog", modalWaitError);

	if (modalVisible) {
		const preselected = (await modal.locator(".ant-select-selection-item").first().innerText().catch(() => "")).trim();
		check(
			preselected.includes(targetName),
			"the dialog preselects the instance the platform was dropped on",
			`expected to contain "${targetName}", got "${preselected || "(nothing selected)"}"`,
		);

		// Nothing is started and nothing is staged: this gesture proposes a transfer, it does not
		// perform one. Cancel so the run leaves no dialog and no pending gateway edit behind.
		await modal.getByRole("button", { name: "Cancel" }).click();
	}

	const savePanel = (await page.locator(".react-flow__panel.top.right").innerText()).trim();
	check(
		!/unsaved change/.test(savePanel),
		"a platform drag stages NO gateway config change",
		`save panel reads "${savePanel}"`,
	);
} catch (err) {
	console.log(`  FAIL harness error — ${err && err.message ? err.message : err}`);
	failed += 1;
} finally {
	await browser.close();
}

if (failed) {
	console.log(`\n=== canvas-drag: ${failed} FAILURE(S) ===`);
	exitCode = 1;
} else {
	console.log("\n=== canvas-drag: all checks passed ===");
}
process.exit(exitCode);
