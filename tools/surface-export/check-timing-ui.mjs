#!/usr/bin/env node
// Browser assertions against the deployed bundle, using the same detail renderer as live logs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const browser = await chromium.launch();
const errors = [];
try {
	const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
	page.on("pageerror", error => errors.push(error.message));
	await page.goto("http://localhost:8080", { waitUntil: "domcontentloaded" });
	const config = JSON.parse(execFileSync("docker", ["exec", "surface-export-controller", "cat", "/clusterio/tokens/config-control.json"], { encoding: "utf8" }));
	await page.evaluate(token => localStorage.setItem("controller_token", token), config["control.controller_token"]);
	await page.goto("http://localhost:8080/surface-export?tab=logs", { waitUntil: "domcontentloaded" });
	await page.getByRole("button", { name: "Preview logs", exact: true }).click();
	const preview = page.getByTestId("log-preview");
	async function scenario(name) {
		await preview.getByRole("combobox", { name: "Preview scenario" }).press("ArrowDown");
		await page.getByText(name, { exact: true }).last().click();
		await preview.getByRole("tab", { name: "Timing", exact: true }).click();
	}
	await scenario("Recorded profiling sample");
	await preview.getByRole("heading", { name: "Source Lua", exact: false }).waitFor();
	const source = preview.locator('[data-clock="sample-clock-1"]');
	const belt = source.locator("tr").filter({ has: page.getByText("belt capture", { exact: true }) });
	assert.equal(await belt.locator("td").nth(4).innerText(), "507.756 ms");
	assert.equal(await belt.locator("td").nth(5).innerText(), "507.67 ms");
	assert.ok(await source.locator(".se-timing-track span").count() > 0);
	assert.equal(await preview.getByRole("heading", { name: "Clusterio orchestration", exact: true }).count(), 1);
	mkdirSync("ci-artifacts/timing", { recursive: true });
	await page.screenshot({ path: "ci-artifacts/timing/profile-waterfalls.png", fullPage: true });
	await scenario("Ticks with missing profiler output");
	assert.equal(await preview.locator(".se-timing-track span").count(), 0, "Tick-only records cannot draw elapsed-time bars");
	await preview.getByText("Tick boundaries and batch counts", { exact: true }).click();
	assert.ok((await preview.innerText()).includes("38520992"), "Exact source tick remains available separately");
	assert.ok((await preview.innerText()).includes("Not measured"));
	await scenario("Recorded success");
	const text = await preview.innerText();
	assert.ok(text.includes("legacy recording"));
	assert.ok(!text.includes("<1 tick") && !text.includes("Not tick-attributed"));
	assert.deepEqual(errors, []);
	console.log("PASS: separate local clocks, recorded profiler values, tick-only geometry exclusion, honest historical display; no browser errors");
} finally { await browser.close(); }
