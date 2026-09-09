// Browser-only request interception: no transfer request reaches the controller.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { launchChromiumOrSkip } from "../../../tools/tests/integration-skip.mjs";
import { assertPageMatchesDisk } from "../../../tools/surface-export/canvas-bundle.mjs";

const browser = await launchChromiumOrSkip("transfer-modal");
try {
	const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
	const errors = [];
	page.on("pageerror", error => errors.push(error.message));
	let requests = 0, release;
	await page.routeWebSocket(/api\/socket/, socket => {
		const server = socket.connectToServer(), pending = new Set();
		socket.onMessage(raw => {
			const frame = JSON.parse(String(raw));
			if (frame.type === "request" && frame.name === "surface_export:StartPlatformTransferRequest") {
				requests++;
				pending.add(frame.src[2]);
				// Preserve the actual wire envelope/sequence, but send only a harmless read.
				frame.name = "surface_export:GetGatewaysRequest";
				frame.data = {};
			}
			server.send(JSON.stringify(frame));
		});
		server.onMessage(raw => {
			const frame = JSON.parse(String(raw));
			if (frame.type === "response" && pending.delete(frame.dst[2])) {
				release = data => { frame.data = data; socket.send(JSON.stringify(frame)); release = undefined; };
			} else socket.send(raw);
		});
	});
	await page.goto("http://localhost:8080", { waitUntil: "domcontentloaded" });
	const config = JSON.parse(execFileSync("docker", ["exec", "surface-export-controller", "cat", "/clusterio/tokens/config-control.json"], { encoding: "utf8" }));
	await page.evaluate(token => localStorage.setItem("controller_token", token), config["control.controller_token"]);
	await page.goto("http://localhost:8080/surface-export?tab=gateways", { waitUntil: "domcontentloaded" });
	const instance = page.locator(".react-flow__node").filter({ has: page.getByText("clusterio-host-1-instance-1", { exact: true }) }).first();
	await instance.getByText("clusterio-host-1-instance-1", { exact: true }).click();
	const row = instance.locator(".surface-export-platform-node-row").first();
	await row.waitFor();
	await row.locator(".surface-export-platform-handle").click();
	const dialog = page.getByRole("dialog");
	await dialog.getByText("Destination instance", { exact: true }).waitFor();
	mkdirSync("ci-artifacts/transfer-modal", { recursive: true });
	await dialog.screenshot({ path: "ci-artifacts/transfer-modal/desktop.png", animations: "disabled" });
	await page.setViewportSize({ width: 360, height: 800 });
	await dialog.screenshot({ path: "ci-artifacts/transfer-modal/mobile-dialog.png", animations: "disabled" });
	const bounds = await dialog.boundingBox();
	assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 360, `Dialog fits a narrow screen: ${JSON.stringify(bounds)}`);
	assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), "No horizontal overflow");
	await page.screenshot({ path: "ci-artifacts/transfer-modal/mobile.png", animations: "disabled" });
	await page.setViewportSize({ width: 1500, height: 1000 });
	await dialog.getByRole("combobox").first().click();
	await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option").first().click();
	await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)").waitFor({ state: "hidden" });
	await dialog.screenshot({ path: "ci-artifacts/transfer-modal/ready.png", animations: "disabled" });
	await dialog.getByRole("button", { name: /Start Transfer/ }).click();
	await dialog.waitFor({ state: "hidden", timeout: 5000 });
	assert.equal(requests, 1);
	assert.ok(release, "Response is still held when the dialog closes");
	await row.locator(".surface-export-platform-handle").click();
	await dialog.getByRole("status").getByText("Starting transfer", { exact: true }).waitFor();
	await dialog.screenshot({ path: "ci-artifacts/transfer-modal/pending.png", animations: "disabled" });
	// AntD includes the loading icon's accessible name in the pending button name.
	assert.ok(await dialog.getByRole("button", { name: /Starting transfer/ }).isDisabled());
	assert.ok(await dialog.getByRole("button", { name: "Cancel", exact: true }).isEnabled());
	for (const input of await dialog.getByRole("combobox").all()) assert.ok(await input.isDisabled());
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await dialog.waitFor({ state: "hidden" });
	assert.equal(requests, 1);
	release({ success: false, error: "Destination is offline — nothing was exported." });
	await page.locator(".ant-message-error").filter({ hasText: "Destination is offline — nothing was exported." }).waitFor();
	assert.equal(await dialog.isVisible(), false, "A rejected request does not reopen the popup");
	await row.locator(".surface-export-platform-handle").click();
	await dialog.getByRole("combobox").first().click();
	await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option").first().click();
	await dialog.getByRole("button", { name: /Start Transfer/ }).click();
	await dialog.waitFor({ state: "hidden", timeout: 5000 });
	for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setTimeout(resolve, 50));
	assert.equal(requests, 2);
	assert.ok(release);
	await row.locator(".surface-export-platform-handle").click();
	await dialog.getByRole("status").waitFor();
	release({ success: true, transferId: "browser-only-transfer" });
	await dialog.getByRole("status").waitFor({ state: "hidden" });
	assert.ok(await dialog.isVisible(), "A late response must not close a newly opened dialog");
	assert.equal(await page.locator(".ant-message-success, .ant-message-info, .ant-message-warning").count(), 0);
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await assertPageMatchesDisk(page);
	assert.deepEqual(errors, []);
	console.log("PASS: immediate close before reply, duplicate submission blocked, error-only toast, retry after failure, late replies preserve reopened dialogs; no real transfer submitted");
} finally { await browser.close(); }
