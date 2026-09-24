#!/usr/bin/env node
// requires: local controller with running debug-mode instances, current web build, Playwright Chromium
// produces: auto-pause badge and legend checks, link endpoints outside every gateway and caption, captures in ci-artifacts/ui-captures
// does not: change instance settings, save gateway links, perform transfers, or approve the visual design
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { assertPageMatchesDisk } from "../../../tools/surface-export/canvas-bundle.mjs";
import { launchChromiumOrSkip } from "../../../tools/tests/integration-skip.mjs";

const base = process.env.SE_WEB_URL || "http://localhost:8080";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const captures = "ci-artifacts/ui-captures";
mkdirSync(captures, { recursive: true });
const browser = await launchChromiumOrSkip("canvas-auto-pause");
const config = JSON.parse(execFileSync("docker", ["exec", process.env.SE_WEB_CONTROLLER || "surface-export-controller", "cat", "/clusterio/tokens/config-control.json"], { encoding: "utf8" }));
const errors = [];
let markedInstanceId = null;

function markTree(tree) {
	const instances = [...(tree?.hosts || []).flatMap(host => host.instances || []), ...(tree?.unassignedInstances || [])]
		.sort((a, b) => a.instanceId - b.instanceId);
	if (!instances.length) return;
	markedInstanceId ??= instances[0].instanceId;
	for (const instance of instances) {
		instance.autoPause = instance.instanceId === markedInstanceId;
		instance.debugMode = true;
	}
}

async function openCanvas(deviceScaleFactor) {
	const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor });
	page.on("pageerror", error => errors.push(error.message));
	await page.routeWebSocket(/api\/socket/, socket => {
		const server = socket.connectToServer();
		const treeRequests = new Set();
		socket.onMessage(raw => {
			const frame = JSON.parse(String(raw));
			if (frame.type === "request" && frame.name === "surface_export:GetPlatformTreeRequest") treeRequests.add(frame.src[2]);
			server.send(raw);
		});
		server.onMessage(raw => {
			const frame = JSON.parse(String(raw));
			if (frame.type === "response" && treeRequests.delete(frame.dst[2])) markTree(frame.data);
			if (frame.name === "surface_export:SurfaceExportTreeUpdateEvent") markTree(frame.data?.tree);
			socket.send(JSON.stringify(frame));
		});
	});
	await page.goto(base);
	await page.evaluate(token => localStorage.setItem("controller_token", token), config["control.controller_token"]);
	await page.goto(`${base}/surface-export?tab=gateways`);
	await page.locator(".react-flow__node").first().waitFor({ state: "visible" });
	await page.waitForFunction(() => typeof window.surfaceExportCanvas?.load === "function", null, { timeout: 30_000 });
	return page;
}

async function settle(page) {
	await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function geometry(page) {
	return page.evaluate(() => {
		const rect = element => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom }; };
		const nodes = [...document.querySelectorAll(".react-flow__node")].map(node => ({
			id: node.dataset.id,
			name: node.querySelector(".surface-export-instance-node-name")?.textContent || "",
			box: rect(node),
			caption: node.querySelector(".surface-export-instance-node-caption") ? rect(node.querySelector(".surface-export-instance-node-caption")) : null,
			badge: node.querySelector(".surface-export-autopause-badge") ? rect(node.querySelector(".surface-export-autopause-badge")) : null,
		}));
		const edges = [...document.querySelectorAll(".react-flow__edge")].map(edge => {
			const path = edge.querySelector(".react-flow__edge-path");
			const matrix = path.getScreenCTM();
			const at = length => { const point = path.getPointAtLength(length); return { x: matrix.a * point.x + matrix.c * point.y + matrix.e, y: matrix.b * point.x + matrix.d * point.y + matrix.f }; };
			return { id: edge.dataset.id || edge.getAttribute("data-testid"), source: at(0), target: at(path.getTotalLength()) };
		});
		return { nodes, edges };
	});
}

const within = (point, box) => box && point.x > box.left + 1 && point.x < box.right - 1 && point.y > box.top + 1 && point.y < box.bottom - 1;

try {
	for (const scale of [1, 2]) {
		const page = await openCanvas(scale);
		await assertPageMatchesDisk(page, { context: "canvas-auto-pause" });
		await page.waitForFunction(() => document.querySelectorAll(".surface-export-autopause-badge").length === 1, null, { timeout: 30_000 });
		const live = await geometry(page);
		const badged = live.nodes.filter(node => node.badge);
		assert.equal(badged.length, 1, "exactly the instance reporting auto-pause carries the badge");
		assert.equal(badged[0].id.endsWith(String(markedInstanceId)), true, `${badged[0].id} is not instance ${markedInstanceId}`);
		const legend = page.locator(".surface-export-legend-autopause");
		assert.equal(await legend.locator("svg[aria-label='auto-pause on']").count(), 1);
		assert.equal((await legend.innerText()).trim(), "auto-pause on");

		await page.evaluate(() => window.surfaceExportCanvas.load({
			instances: [
				{ name: "north", platforms: ["alpha"] },
				{ name: "south (auto-pause)", platforms: ["beta"], autoPause: true },
				{ name: "east", host: "scenario east", platforms: ["gamma"] },
			],
			links: [[0, 1], [1, 0], [0, 2]],
		}));
		await page.waitForFunction(() => document.querySelectorAll(".react-flow__edge").length === 3
			&& document.querySelectorAll(".surface-export-autopause-badge").length === 1, null, { timeout: 10_000 });
		await page.locator(".react-flow__controls-fitview").click();
		await page.waitForTimeout(400);
		await settle(page);
		const staged = await geometry(page);
		const south = staged.nodes.find(node => node.name.startsWith("south"));
		assert.ok(south?.badge, "the scenario's auto-paused gateway carries the badge");
		const face = { x: (south.box.left + south.box.right) / 2, y: (south.box.top + south.box.bottom) / 2 };
		const badge = { x: (south.badge.left + south.badge.right) / 2, y: (south.badge.top + south.badge.bottom) / 2 };
		assert.ok(Math.abs(badge.x - face.x) < 2 && badge.y < face.y, `badge ${JSON.stringify(badge)} is not over the portal of ${JSON.stringify(face)}`);
		for (const edge of staged.edges) {
			for (const [end, point] of [["source", edge.source], ["target", edge.target]]) {
				for (const node of staged.nodes) {
					assert.equal(within(point, node.box) || within(point, node.caption), false,
						`${edge.id} ${end} ${JSON.stringify(point)} ends inside ${node.name}: ${JSON.stringify(node)}`);
				}
			}
		}
		const suffix = scale === 1 ? "" : `@${scale}x`;
		await page.screenshot({ path: `${captures}/gateway-canvas${suffix}.png` });
		const union = staged.nodes.reduce((box, node) => ({
			left: Math.min(box.left, node.box.left, node.caption?.left ?? Infinity), top: Math.min(box.top, node.caption?.top ?? node.box.top),
			right: Math.max(box.right, node.box.right, node.caption?.right ?? -Infinity), bottom: Math.max(box.bottom, node.box.bottom),
		}), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
		await page.screenshot({ path: `${captures}/gateway-links${suffix}.png`, clip: {
			x: Math.max(0, union.left - 30), y: Math.max(0, union.top - 30), width: union.right - union.left + 60, height: union.bottom - union.top + 60 } });
		await page.screenshot({ path: `${captures}/auto-pause-badge${suffix}.png`, clip: {
			x: south.box.left - 30, y: (south.caption?.top ?? south.box.top) - 20, width: south.box.right - south.box.left + 60,
			height: south.box.bottom - (south.caption?.top ?? south.box.top) + 40 } });
		await legend.screenshot({ path: `${captures}/auto-pause-legend${suffix}.png` });
		writeFileSync(`${captures}/gateway-geometry${suffix}.json`, JSON.stringify(staged, null, 2));
		await page.close();
		console.log(`PASS scale ${scale}: auto-pause badge follows the tree, legend key present, every link ends outside gateways and captions`);
	}
	assert.deepEqual(errors, []);
} catch (error) {
	writeFileSync("ci-artifacts/canvas-auto-pause-failure.json", JSON.stringify({ error: String(error), errors, markedInstanceId }, null, 2));
	throw error;
} finally {
	await browser.close();
}
