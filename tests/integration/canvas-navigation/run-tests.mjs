#!/usr/bin/env node
// requires: local controller with instances, current web build, Playwright Chromium
// produces: visible gateway nodes and routes after sidebar navigation and delayed gateway settings
// does not: save gateway settings, perform transfers, or change game state
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { assertPageMatchesDisk } from "../../../tools/surface-export/canvas-bundle.mjs";
import { launchChromiumOrSkip } from "../../../tools/tests/integration-skip.mjs";

const base = process.env.SE_WEB_URL || "http://localhost:8080";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const browser = await launchChromiumOrSkip("canvas-navigation");
const config = JSON.parse(execFileSync("docker", ["exec", "surface-export-controller", "cat", "/clusterio/tokens/config-control.json"], { encoding: "utf8" }));
const errors = [];
const page = await browser.newPage({ viewport: { width: 1683, height: 1282 } });
page.on("pageerror", error => errors.push(error.message));
let holdSettings = false;
let releaseSettings;
let settingsResponses = 0;
const heldRequests = [];
await page.routeWebSocket(/api\/socket/, socket => {
	const server = socket.connectToServer();
	const pending = new Set();
	socket.onMessage(raw => {
		const frame = JSON.parse(String(raw));
		if (frame.type === "request" && frame.name === "surface_export:GetGatewaysRequest") {
			pending.add(frame.src[2]);
			if (holdSettings) {
				heldRequests.push(raw);
				return;
			}
		}
		server.send(raw);
	});
	server.onMessage(raw => {
		const frame = JSON.parse(String(raw));
		if (frame.type === "response" && pending.delete(frame.dst[2])) settingsResponses++;
		socket.send(raw);
	});
	releaseSettings = () => {
		holdSettings = false;
		for (const raw of heldRequests.splice(0)) server.send(raw);
	};
});

async function visibleNodes() {
	await page.waitForFunction(() => {
		const nodes = [...document.querySelectorAll(".react-flow__node")];
		return nodes.length > 0 && nodes.every(node => getComputedStyle(node).visibility === "visible"
			&& node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0);
	}, null, { timeout: 5000 });
}

async function settingsAfter(before) {
	for (let poll = 0; settingsResponses === before && poll < 500; poll++) await page.waitForTimeout(20);
	assert.equal(settingsResponses, before + 1, "the gateway response reached the page");
}

try {
	await page.goto(base);
	await page.evaluate(token => localStorage.setItem("controller_token", token), config["control.controller_token"]);
	await page.goto(`${base}/surface-export?tab=gateways`);
	await page.locator(".react-flow__node").first().waitFor({ state: "attached" });
	await settingsAfter(0);
	await visibleNodes();
	await assertPageMatchesDisk(page, { context: "canvas-navigation" });
	const nodeIds = await page.locator(".react-flow__node").evaluateAll(nodes => nodes.map(node => node.dataset.id).sort());
	const positions = await page.locator(".react-flow__node").evaluateAll(nodes => nodes.map(node => [node.dataset.id, node.style.transform]));
	const sidebar = page.getByRole("menu");
	for (const destination of ["Hosts", "Plugins", "Instances"]) {
		await sidebar.getByRole("link", { name: destination, exact: true }).click();
		await page.locator(".react-flow").waitFor({ state: "detached" });
		holdSettings = true;
		const before = settingsResponses;
		await sidebar.getByRole("link", { name: "Surface Export", exact: true }).click();
		await visibleNodes();
		await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		assert.equal(heldRequests.length, 1, "hold the settings refresh until the cached nodes are measured");
		releaseSettings();
		await settingsAfter(before);
		await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		await visibleNodes();
		assert.deepEqual(await page.locator(".react-flow__node").evaluateAll(nodes => nodes.map(node => node.dataset.id).sort()), nodeIds);
		assert.deepEqual(await page.locator(".react-flow__node").evaluateAll(nodes => nodes.map(node => [node.dataset.id, node.style.transform])), positions);
		await page.waitForFunction(() => document.querySelectorAll(".react-flow__edge").length
			>= window.surfaceExportCanvas.describe().links);
		await page.getByRole("tab", { name: "Transaction Logs", exact: true }).click();
		await page.getByRole("tab", { name: "Gateways", exact: true }).click();
		await visibleNodes();
		console.log(`PASS ${destination} → Surface Export: nodes, positions, routes and tab visibility survive the delayed refresh`);
	}
	assert.deepEqual(errors, []);
} catch (error) {
	mkdirSync("ci-artifacts", { recursive: true });
	const nodes = await page.locator(".react-flow__node").evaluateAll(nodes => nodes.map(node => ({
		id: node.dataset.id, style: node.getAttribute("style"), box: node.getBoundingClientRect().toJSON(),
	})));
	writeFileSync("ci-artifacts/canvas-navigation-failure.json", JSON.stringify({
		error: String(error), url: page.url(), nodes, errors,
		page: await page.locator("body").innerText(),
	}, null, 2));
	await page.screenshot({ path: "ci-artifacts/canvas-navigation-failure.png" });
	throw error;
} finally {
	await browser.close();
}
