#!/usr/bin/env node
// requires: live local controller, built web bundle, Playwright Chromium
// produces: assertions against the real EdgeTransfers renderer in its preview dialog
// does not: transfer platforms, save gateway links, or prove server transfer correctness
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { assertPageMatchesDisk } from "../../../tools/surface-export/canvas-bundle.mjs";
import { launchChromiumOrSkip } from "../../../tools/tests/integration-skip.mjs";

const base = process.env.SE_WEB_URL || "http://localhost:8080";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname), "local credentials stay on localhost");
const browser = await launchChromiumOrSkip("canvas-motion");
try {
	const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, reducedMotion: "no-preference" });
	const errors = [];
	page.on("pageerror", error => errors.push(error.message));
	const config = execFileSync("docker", ["exec", "surface-export-controller", "cat", "/clusterio/tokens/config-control.json"], { encoding: "utf8" });
	const token = JSON.parse(config)["control.controller_token"];
	assert.equal(typeof token, "string");
	await page.goto(base);
	await page.evaluate(value => localStorage.setItem("controller_token", value), token);
	await page.goto(`${base}/surface-export?tab=gateways`);
	await page.getByRole("button", { name: "toggle debug mode", exact: true }).click();
	await page.getByRole("button", { name: "Preview round trip", exact: true }).click();
	await page.getByRole("button", { name: "Pause", exact: true }).click();
	await assertPageMatchesDisk(page, { context: "canvas-motion" });
	const scene = page.getByTestId("transfer-motion-preview");
	const ship = scene.locator("[data-transfer-id]");
	const next = () => page.getByRole("button", { name: "Next phase", exact: true }).click();
	const position = () => ship.evaluate(el => parseFloat(getComputedStyle(el).offsetDistance));
	const settledAt = async distance => {
		await page.waitForFunction(expected => {
			const el = document.querySelector('[data-testid="transfer-motion-preview"] [data-transfer-id]');
			return el && Math.abs(parseFloat(getComputedStyle(el).offsetDistance) - expected) < 0.001;
		}, distance);
	};
	const moveTo = async (from, to, label) => {
		const original = await ship.elementHandle();
		assert.ok(Math.abs(await position() - from) < 0.001);
		await next();
		const samples = await original.evaluate(async el => {
			const values = [];
			const start = performance.now();
			while (performance.now() - start < 1200) {
				values.push(parseFloat(getComputedStyle(el).offsetDistance));
				await new Promise(requestAnimationFrame);
			}
			return { values, connected: el.isConnected };
		});
		assert.ok(samples.connected, `${label}: the moving element must survive the phase change`);
		assert.ok(samples.values.some(value => value > Math.min(from, to) && value < Math.max(from, to)),
			`${label}: must render intermediate positions, not jump to the endpoint`);
		assert.ok(Math.abs(await position() - to) < 0.001, `${label}: reaches correct endpoint`);
		assert.equal(await ship.evaluate(el => getComputedStyle(el).visibility), "hidden", "only settled ships join markers");
		assert.equal(await scene.locator(".surface-export-edge-status").count(), 1);
		console.log(`PASS ${label}`);
	};

	await settledAt(50);
	await next(); // validation
	await page.waitForTimeout(10500);
	assert.ok(Number(await scene.locator(".surface-export-edge-status").evaluate(el => getComputedStyle(el).opacity)) > 0.1);
	console.log("PASS validation remains visible beyond ten seconds");
	await moveTo(50, 100, "forward arrival");
	await next(); // reverse departure
	await settledAt(50);
	await next(); // reverse validation
	await moveTo(50, 100, "reverse failure returns to its source");
	await next(); // retry reverse departure
	await settledAt(50);
	await next(); // reverse validation
	await moveTo(50, 0, "cleanup failure still arrives at its destination");
	assert.match(await scene.locator(".surface-export-edge-status").getAttribute("class"), /ship-failure/);
	await page.emulateMedia({ reducedMotion: "reduce" });
	await next(); // next forward journey
	await settledAt(50);
	await next(); // validation
	assert.equal(await scene.locator(".surface-export-edge-status").evaluate(el => getComputedStyle(el).animationName), "none");
	console.log("PASS reduced-motion preference");
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await page.getByRole("button", { name: "Preview round trip", exact: true }).click();
	await page.getByRole("button", { name: "Pause", exact: true }).click();
	const interrupted = await ship.elementHandle();
	await next(); // validation arrives before departure animation has finished
	await next(); // completion immediately follows
	const first = await position();
	assert.ok(first > 0 && first < 100, "rapid phase updates must continue from an intermediate position");
	await settledAt(100);
	assert.ok(await interrupted.evaluate(el => el.isConnected), "rapid updates must preserve the moving element");
	console.log("PASS rapid phase updates preserve the journey");
	assert.deepEqual(errors, [], "preview must not raise browser errors");
} finally {
	await browser.close();
}
