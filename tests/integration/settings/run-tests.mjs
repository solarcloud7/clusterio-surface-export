// Real browser/config reads; all configuration writes are intercepted and replaced with reads.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { launchChromiumOrSkip } from "../../../tools/tests/integration-skip.mjs";
import { assertPageMatchesDisk } from "../../../tools/surface-export/canvas-bundle.mjs";

const browser = await launchChromiumOrSkip("settings");
try {
	const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
	const errors = [], writes = [];
	let mode = "admin", failSave = false, failRead = false;
	const shadow = {};
	page.on("pageerror", error => errors.push(error.message));
	await page.routeWebSocket(/api\/socket/, socket => {
		const server = socket.connectToServer(), pending = new Map();
		socket.onMessage(raw => {
			const frame = JSON.parse(String(raw));
			if (frame.type === "request" && frame.name === "ControllerConfigSetRequest") {
				writes.push(frame.data.fields);
				pending.set(frame.src[2], { write: frame.data.fields });
				frame.name = "ControllerConfigGetRequest";
				delete frame.data;
			} else if (frame.type === "request" && frame.name === "ControllerConfigGetRequest") pending.set(frame.src[2], {});
			server.send(JSON.stringify(frame));
		});
		server.onMessage(raw => {
			const frame = JSON.parse(String(raw));
			if (frame.type === "ready" && mode !== "admin") {
				frame.data.account.roles = [{ id: 99, name: "Browser test", permissions: ["surface_export.ui.view", ...(mode === "reader" ? ["core.controller.get_config"] : [])] }];
			}
			const operation = frame.type === "response" ? pending.get(frame.dst[2]) : undefined;
			if (operation) {
				pending.delete(frame.dst[2]);
				if ((operation.write && failSave) || (!operation.write && failRead)) {
					frame.type = "responseError";
					frame.data = { message: operation.write ? "Injected settings save failure" : "Injected settings read failure", code: "RequestError" };
				} else if (operation.write) {
					for (const [key, value] of Object.entries(operation.write)) shadow[key] = key.endsWith("gateway_mode") ? value : Number(value);
					delete frame.data;
				} else Object.assign(frame.data, shadow);
			}
			socket.send(JSON.stringify(frame));
		});
	});
	await page.goto("http://localhost:8080", { waitUntil: "domcontentloaded" });
	const config = JSON.parse(execFileSync("docker", ["exec", "surface-export-controller", "cat", "/clusterio/tokens/config-control.json"], { encoding: "utf8" }));
	await page.evaluate(token => localStorage.setItem("controller_token", token), config["control.controller_token"]);
	await page.goto("http://localhost:8080/surface-export?tab=settings", { waitUntil: "domcontentloaded" });
	const input = page.getByRole("spinbutton", { name: "Saved Detailed Transfer Logs" });
	await input.waitFor();
	assert.equal(await page.getByRole("spinbutton", { name: "Stored Payload Downloads" }).count(), 1);
	assert.equal(await page.locator(".se-settings .ant-select").count(), 0, "Gateway mode is not editable here");
	assert.equal(await page.locator(".se-settings aside ul").count(), 0, "Instance names are not listed");
	assert.equal(await page.locator(".se-settings .ant-form-item").count(), 3, "Only the three supported settings are shown");
	assert.equal(await page.getByRole("region", { name: "Transfer records", exact: true }).count(), 1);
	assert.equal(await page.getByRole("region", { name: "Transfer recovery", exact: true }).count(), 1);
	assert.ok(await page.getByRole("button", { name: "Save changes" }).isDisabled());
	const batchHelp = page.locator(".se-settings-reference details").filter({ hasText: "Batch sizes" });
	await batchHelp.locator("summary").focus();
	await page.keyboard.press("Enter");
	assert.ok(await batchHelp.locator("p").isVisible(), "Instance guidance opens from the keyboard");
	await page.keyboard.press("Enter");
	assert.ok(!(await batchHelp.locator("p").isVisible()), "Instance guidance collapses from the keyboard");
	const original = Number(await input.inputValue());
	const changed = original === 101 ? 102 : 101;
	await input.fill(String(changed));
	await page.getByRole("status").filter({ hasText: "Unsaved changes" }).waitFor();
	await page.getByRole("button", { name: "Discard changes" }).click();
	assert.equal(await input.inputValue(), String(original));
	assert.equal(writes.length, 0);
	await input.fill(String(changed));
	await page.getByRole("button", { name: "Save changes" }).click();
	await page.getByRole("status").filter({ hasText: "Settings saved." }).waitFor();
	assert.deepEqual(writes, [{ "surface_export.transaction_log_detail_entries": String(changed) }]);
	assert.equal(await input.inputValue(), String(changed));
	failSave = true;
	await input.fill("103");
	await page.getByRole("button", { name: "Save changes" }).click();
	await page.getByRole("alert").filter({ hasText: "Injected settings save failure" }).waitFor();
	assert.equal(await input.inputValue(), "103", "Failed save preserves edits");
	await page.getByRole("button", { name: "Discard changes" }).click();
	assert.equal(await input.inputValue(), String(changed));
	failSave = false;
	await page.getByRole("tab", { name: "Gateways", exact: true }).click();
	await page.getByRole("tab", { name: "Settings", exact: true }).click();
	await input.waitFor();
	mkdirSync("ci-artifacts/settings", { recursive: true });
	await page.locator(".se-settings").screenshot({ path: "ci-artifacts/settings/desktop.png" });
	await page.setViewportSize({ width: 1000, height: 900 });
	assert.ok(await page.locator(".se-settings").evaluate(el => el.scrollWidth <= el.clientWidth), "Tablet settings have no horizontal overflow");
	await page.setViewportSize({ width: 390, height: 844 });
	assert.ok(await page.locator(".se-settings").evaluate(el => el.scrollWidth <= el.clientWidth), "Settings content has no horizontal overflow");
	await page.screenshot({ path: "ci-artifacts/settings/mobile.png", fullPage: true });
	await page.setViewportSize({ width: 1500, height: 1000 });
	await assertPageMatchesDisk(page);
	failRead = true;
	await page.reload();
	await page.getByRole("alert").filter({ hasText: "Injected settings read failure" }).waitFor();
	assert.equal(await input.count(), 0, "Failed initial read cannot display invented defaults");
	failRead = false;
	mode = "reader";
	await page.reload();
	await page.getByText("Read only. Saving requires permission to update controller configuration.").waitFor();
	assert.ok(await input.isDisabled());
	mode = "denied";
	await page.reload();
	await page.getByText("Controller settings require permission to view controller configuration.").waitFor();
	assert.equal(await input.count(), 0);
	assert.deepEqual(errors, []);
	console.log("PASS: grouped settings, keyboard guidance, dirty-only intercepted save, discard, save/read failures, read-only/denied permissions, tab return, desktop/tablet/mobile layout; no real configuration writes");
} finally { await browser.close(); }
