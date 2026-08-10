#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

import { assertPageMatchesDisk } from "../../../tools/surface-export/canvas-bundle.mjs";

const CONTROLLER_CONTAINER = "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";
const BASE_URL = process.env.SE_WEB_URL || "http://localhost:8080";
const CANVAS_URL = `${BASE_URL}/surface-export?tab=gateways`;

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

	const page = await context.newPage();
	page.on("pageerror", err => console.log(`  [page error] ${err.message}`));

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

	const bundle = await assertPageMatchesDisk(page, { context: "canvas-drag" });
	check(true, `page is running the build on disk (${bundle})`);
	const nodeCount = await nodes.count();
	check(nodeCount >= 2, "the canvas has at least two instances to drag between", `found ${nodeCount}`);
	if (nodeCount < 2) {
		throw new Error("cannot test a transfer drag with fewer than two instances");
	}

	const sourceNode = nodes.nth(0);
	const targetNode = nodes.nth(1);
	const targetName = (await targetNode.locator(".surface-export-instance-node-name").innerText()).trim();

	await page.waitForTimeout(2500);

	const gateway = await centreOf(sourceNode.locator(".surface-export-gw-cover").first());
	await page.mouse.move(gateway.x, gateway.y);
	await page.mouse.down();
	await page.mouse.move(gateway.x + 120, gateway.y + 90);
	await page.mouse.move(gateway.x + 240, gateway.y + 180);
	await page.waitForTimeout(120);
	const dragPath = await page.evaluate(
		() => document.querySelector(".react-flow__connectionline path")?.getAttribute("d") ?? null,
	);
	await page.mouse.up();
	await page.waitForTimeout(300);
	await page.keyboard.press("Escape");

	check(
		Boolean(dragPath),
		"a gateway drag renders a connection line (control arm)",
		"no .react-flow__connectionline path existed mid-drag — the shape check below would pass vacuously",
	);
	check(
		Boolean(dragPath) && / L /.test(dragPath) && !/[CQAS]/.test(dragPath),
		"the gateway drag line is straight, not a curve",
		`connection line d="${dragPath ?? "(absent)"}"`,
	);

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

	await handle.hover();

	const from = await centreOf(handle);
	const to = await centreOf(targetNode.locator(".surface-export-gw-cover").first());
	await dragBetween(page, from, to);

	const modal = page.locator(".ant-modal-wrap:not([style*='display: none']) .ant-modal");
	let modalVisible = true;
	let modalWaitError = "";
	try {
		await modal.waitFor({ state: "visible", timeout: 5000 });
	} catch (err) {
		modalVisible = false;
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
