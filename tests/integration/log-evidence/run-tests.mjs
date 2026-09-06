#!/usr/bin/env node
// requires: local controller, current web build, Playwright Chromium
// produces: browser assertions using sanitized runtime records and delayed/error log responses
// does not: perform transfers, change validation rules, or write synthetic evidence to the controller
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { assertPageMatchesDisk } from "../../../tools/surface-export/canvas-bundle.mjs";
import { launchChromiumOrSkip } from "../../../tools/tests/integration-skip.mjs";

const base = process.env.SE_WEB_URL || "http://localhost:8080";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname), "credentials stay on localhost");
const browser = await launchChromiumOrSkip("log-evidence");
const config = JSON.parse(execFileSync("docker", ["exec", "surface-export-controller", "cat", "/clusterio/tokens/config-control.json"], { encoding: "utf8" }));
const token = config["control.controller_token"];
const errors = [];
let isolatedLiveUpdates = 0;
// Keep this suite repeatable on freshly seeded CI: only this browser receives the recorded fixtures.
const recorded = JSON.parse(readFileSync(new URL("../../../docker/seed-data/external_plugins/surface_export/web/logs/recorded-fixtures.ts", import.meta.url), "utf8")
	.replace(/^[\s\S]*?export default /, "").replace(/;\s*$/, ""));
const history = Array.from({ length: 16 }, (_, index) => {
	const fixture = structuredClone(index < 14 ? recorded.success : recorded.failure);
	fixture.row.transferId = `browser-record-${String(index).padStart(2, "0")}`;
	fixture.row.downloadable = false;
	if (index === 14) { fixture.row.downloadable = true; fixture.row.exportId = "browser-artifact"; }
	if (index === 15) fixture.row.operationType = "import";
	fixture.detail.transferInfo = { ...fixture.row };
	fixture.detail.summary.transferId = fixture.row.transferId;
	fixture.detail.summary.operationType = fixture.row.operationType;
	return fixture;
});
function connectHistory(socket) {
	const server = socket.connectToServer(), pending = new Map();
	socket.onMessage(raw => {
		const frame = JSON.parse(String(raw));
		if (frame.type === "request") pending.set(frame.src[2], frame);
		server.send(raw);
	});
	return { server, replace(frame) {
		// Initial subscriptions can replay real transfers from earlier suites. Keep this
		// browser's fixture history isolated; explicit race-test pushes bypass this hook.
		if (frame.type === "event" && ["surface_export:SurfaceExportTransferUpdateEvent", "surface_export:SurfaceExportLogUpdateEvent"].includes(frame.name)) {
			frame.data.revision = 0;
			isolatedLiveUpdates++;
		}
		if (frame.type !== "response") return;
		const request = pending.get(frame.dst[2]);
		pending.delete(frame.dst[2]);
		if (request?.name === "surface_export:ListTransactionLogsRequest") frame.data = history.map(entry => entry.row);
		if (request?.name === "surface_export:GetTransactionLogRequest") {
			const fixture = history.find(entry => entry.row.transferId === request.data.transferId);
			if (fixture) frame.data = { success: true, transferId: fixture.row.transferId, ...structuredClone(fixture.detail) };
		}
	} };
}
const signIn = async page => {
	page.on("pageerror", error => errors.push(error.message));
	await page.goto(base);
	await page.evaluate(value => localStorage.setItem("controller_token", value), token);
	await page.goto(`${base}/surface-export?tab=logs`);
};
const readReport = async scope => {
	const page = scope.page();
	const pending = page.waitForEvent("download");
	await scope.getByRole("button", { name: "Download diagnostic report", exact: true }).click();
	return JSON.parse(readFileSync(await (await pending).path(), "utf8"));
};
const select = async (page, label, option) => {
	await page.getByRole("combobox", { name: label, exact: true }).press("ArrowDown");
	await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)").getByText(option, { exact: true }).click();
};
try {
	const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
	await page.routeWebSocket(/api\/socket/, socket => {
		const wire = connectHistory(socket);
		wire.server.onMessage(raw => { const frame = JSON.parse(String(raw)); wire.replace(frame); socket.send(JSON.stringify(frame)); });
	});
	let requests = 0;
	page.on("websocket", ws => ws.on("framesent", frame => {
		const data = JSON.parse(String(frame.payload));
		if (data.name?.startsWith("surface_export:")) requests++;
	}));
	await signIn(page);
	const logs = page.getByTestId("transfer-logs"), detail = logs.getByTestId("transfer-detail");
	await detail.getByText("Arrived and verified", { exact: true }).waitFor();
	await assertPageMatchesDisk(page, { context: "log-evidence" });
	assert.match(await logs.innerText(), /Searching \d+ loaded operations/);
	const selected = await page.locator(".se-history-row.is-selected").getAttribute("data-transfer-id");
	assert.equal(selected, "browser-record-00");
	const report = await readReport(detail);
	assert.equal(report.transferId, selected);
	assert.equal(report.schemaVersion, 1);
	assert.equal(report.preview, false);
	assert.ok(report.events.length > 0);
	await page.getByRole("textbox", { name: "Search loaded operations" }).fill(selected);
	assert.equal(await page.locator(".se-history-row").count(), 1);
	await page.getByRole("textbox", { name: "Search loaded operations" }).fill("no-such-operation-in-history");
	await page.getByText("No operations match these filters", { exact: true }).waitFor();
	assert.equal((await readReport(detail)).transferId, selected, "filters preserve the selected detail");
	await page.getByRole("textbox", { name: "Search loaded operations" }).fill("");
	await page.locator('.se-history [title="2"]').click();
	assert.equal((await readReport(detail)).transferId, selected, "pagination preserves selection");
	const keyboardRow = page.locator(".se-history-row").first();
	await keyboardRow.focus(); await page.keyboard.press("Enter");
	assert.equal(await keyboardRow.getAttribute("aria-pressed"), "true");
	await select(page, "Outcome filter", "Needs attention");
	const failure = page.locator(".se-history-row").filter({ hasText: "Cargo trial" }).first();
	await failure.click();
	await detail.getByText(/Failed; rollback succeeded/).waitFor();
	assert.equal(await detail.getByRole("button", { name: /Download platform/ }).isEnabled(), true, "loading detail preserves the stored-export download action");
	await detail.getByRole("tab", { name: "Items", exact: true }).click();
	await detail.getByText("Item audit · Mismatch", { exact: true }).waitFor();
	await select(page, "Operation filter", "Imports");
	assert.ok((await page.locator(".se-history-row").allTextContents()).every(text => text.includes("Uploaded file")));
	await select(page, "Outcome filter", "All outcomes");
	await select(page, "Operation filter", "All operations");
	const originalValidation = structuredClone(history[0].detail.summary.validation);
	history[0].detail.summary.validation.success = false;
	history[0].detail.summary.validation.itemCountMatch = false;
	await page.locator('.se-history-row[data-transfer-id="browser-record-00"]').click();
	await detail.getByText("Completed; audit reported a failure", { exact: true }).waitFor();
	history[0].detail.summary.validation = originalValidation;
	await page.locator('.se-history-row[data-transfer-id="browser-record-01"]').click();
	await page.locator('.se-history-row[data-transfer-id="browser-record-00"]').click();
	await detail.getByText("Arrived and verified", { exact: true }).waitFor();
	await detail.getByRole("tab", { name: "Overview", exact: true }).click();
	console.log("PASS recorded success/failure, reports, search, filters, pagination, keyboard selection and refreshing revisited evidence");

	const beforePreview = requests;
	await page.getByRole("button", { name: "Preview logs", exact: true }).click();
	const preview = page.getByTestId("log-preview"), previewDetail = preview.getByTestId("transfer-detail");
	const scenario = async name => {
		await select(page, "Preview scenario", name);
		const overview = preview.getByRole("tab", { name: "Overview", exact: true });
		if (await overview.isVisible()) await overview.click();
	};
	await preview.getByText("Arrived and verified", { exact: true }).waitFor();
	await scenario("Recorded profiling sample");
	await preview.getByRole("tab", { name: "Timing", exact: true }).click();
	const sourceTiming = preview.locator('[data-clock="sample-clock-1"]');
	const beltTiming = sourceTiming.locator("tr").filter({ has: page.getByText("belt capture", { exact: true }) });
	assert.equal(await beltTiming.locator("td").nth(4).innerText(), "507.756 ms");
	assert.equal(await beltTiming.locator("td").nth(5).innerText(), "507.67 ms");
	assert.equal(await preview.getByRole("heading", { name: "Clusterio orchestration", exact: true }).count(), 1);
	assert.ok(await sourceTiming.locator(".se-timing-track span").count() > 0);
	assert.ok((await readReport(previewDetail)).summary.timing.records.length > 0);
	await scenario("Ticks with missing profiler output");
	await preview.getByRole("tab", { name: "Timing", exact: true }).click();
	assert.equal(await preview.locator(".se-timing-track span").count(), 0, "Tick-only records cannot draw elapsed-time bars");
	await preview.getByText("Tick boundaries and batch counts", { exact: true }).click();
	assert.match(await preview.innerText(), /38520992/);
	assert.match(await preview.innerText(), /Not measured/);
	console.log("PASS local-clock waterfalls, raw profiler values and tick-only geometry exclusion");
	await scenario("Recorded success");
	await preview.getByRole("tab", { name: "Fluids", exact: true }).click();
	await preview.getByText("Measured empty cargo — zero recorded types", { exact: true }).waitFor();
	await preview.getByRole("tab", { name: "Timing", exact: true }).click();
	assert.ok(!(await preview.innerText()).includes("<1 tick"), "Tick evidence must not become a duration bound in the waterfall");
	assert.ok((await preview.innerText()).includes("legacy recording"), "Historical elapsed records must identify their provenance");
	assert.match(await preview.innerText(), /Stages can overlap/);
	await preview.getByRole("tab", { name: "Items", exact: true }).click();
	await preview.getByRole("textbox", { name: "Search items" }).fill("coal");
	await preview.getByRole("button", { name: "Replay detail update" }).click();
	assert.equal(await preview.getByRole("textbox", { name: "Search items" }).inputValue(), "coal");
	await preview.getByRole("tab", { name: "Technical details", exact: true }).click();
	await preview.getByText("Validation evidence and entity breakdown", { exact: true }).click();
	await preview.getByRole("button", { name: "Replay detail update" }).click();
	assert.equal(await preview.locator('.ant-collapse-header').first().getAttribute("aria-expanded"), "true");
	await scenario("Recorded failure and rollback");
	await preview.getByText(/Failed; rollback succeeded/).waitFor();
	await preview.getByText("Intentional test", { exact: true }).waitFor();
	await scenario("Failure, recovery unknown");
	await preview.getByText("Failed; recovery not confirmed", { exact: true }).waitFor();
	await scenario("Cleanup needs attention");
	assert.doesNotMatch(await previewDetail.innerText(), /Arrived and verified/);
	await scenario("Validation pending");
	assert.equal(await preview.locator(".se-audit-pending").count(), 2);
	await scenario("Missing audit evidence");
	assert.equal(await preview.locator(".se-audit-unavailable").count(), 2);
	assert.match(await previewDetail.innerText(), /Not recorded/);
	await scenario("Equal totals, failed gate");
	await preview.getByText("Completed; audit reported a failure", { exact: true }).waitFor();
	await preview.getByRole("tab", { name: "Items", exact: true }).click();
	await preview.getByRole("textbox", { name: "Search items" }).fill("");
	await preview.getByRole("switch", { name: "items differences only" }).click();
	assert.ok((await preview.getByTestId("audit-items").innerText()).includes("iron-plate"));
	await scenario("Thermally reconciled fluids");
	await preview.getByRole("tab", { name: "Fluids", exact: true }).click();
	await preview.getByText("fusion-plasma@1000000C", { exact: true }).waitFor();
	await preview.getByText("fusion-plasma@999999C", { exact: true }).waitFor();
	await preview.getByText("Thermal reconciliation", { exact: true }).click();
	await preview.getByText("Reconciled", { exact: true }).waitFor();
	assert.doesNotMatch(await preview.getByTestId("audit-fluids").innerText(), /exact/i);
	await scenario("Expired details");
	await preview.getByText("Detailed evidence has expired", { exact: true }).waitFor();
	const expired = await readReport(previewDetail);
	assert.equal(expired.detailRetention, "summary-only"); assert.deepEqual(expired.events, []); assert.equal(expired.preview, true);
	await scenario("Standalone export");
	assert.equal(await preview.locator(".se-audit-not-applicable").count(), 2);
	await preview.getByText("Export stored", { exact: true }).waitFor();
	await scenario("Standalone import");
	await preview.getByText("Imported and verified", { exact: true }).waitFor();
	await scenario("Retryable load error");
	await preview.getByRole("button", { name: "Retry", exact: true }).click();
	await preview.getByText("Arrived and verified", { exact: true }).waitFor();
	await scenario("Loading details");
	await preview.getByText("Loading recorded evidence…", { exact: true }).waitFor();
	await page.getByRole("button", { name: "Close", exact: true }).click();
	assert.equal(requests, beforePreview, "preview must not send plugin requests");
	console.log("PASS preview verdicts, raw/thermal audit evidence, retained/expired reports, retry and stable detail updates");

	mkdirSync("ci-artifacts/log-evidence", { recursive: true });
	await page.screenshot({ path: "ci-artifacts/log-evidence/desktop.png", fullPage: true });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: "ci-artifacts/log-evidence/mobile.png", fullPage: true });
	assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "mobile page must not overflow horizontally");
	console.log("PASS desktop/mobile layout");

	// Route only this test browser's incoming data. The controller's records remain unchanged.
	const racePage = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
	let failNext = true, pushNext = false, offset = 0, latestResponse, routeHandle;
	await racePage.routeWebSocket(/api\/socket/, socket => {
		routeHandle = socket;
		const wire = connectHistory(socket);
		wire.server.onMessage(raw => {
			const frame = JSON.parse(String(raw));
			wire.replace(frame);
			if (typeof frame.seq === "number") frame.seq += offset;
			if (frame.type === "response" && frame.data?.events && frame.data?.transferId) {
				latestResponse = structuredClone(frame);
				if (failNext) { failNext = false; frame.data = { success: false, error: "Injected read failure" }; }
				else if (pushNext) {
					pushNext = false;
					const info = { ...frame.data.transferInfo, status: "cleanup_failed", error: "Browser-only cleanup evidence", failedAt: Date.now() };
					socket.send(JSON.stringify({ type: "event", seq: frame.seq, src: frame.src, dst: frame.dst.slice(0, 2), name: "surface_export:SurfaceExportLogUpdateEvent", data: {
						revision: 900000, generatedAt: Date.now(), transferId: info.transferId,
						event: { timestampMs: Date.now(), eventType: "cleanup_failed", message: "Browser-only cleanup evidence" },
						transferInfo: info, summary: { ...frame.data.summary, status: "cleanup_failed", error: info.error },
					} }));
					offset++; frame.seq++;
				}
			}
			socket.send(JSON.stringify(frame));
		});
	});
	await signIn(racePage);
	await racePage.getByText("Injected read failure", { exact: true }).waitFor();
	await racePage.getByRole("textbox", { name: "Search loaded operations" }).fill("1");
	await racePage.locator('.se-history [title="2"]').click();
	pushNext = true;
	await racePage.getByRole("button", { name: "Retry", exact: true }).click();
	const raceDetail = racePage.getByTestId("transfer-detail");
	await raceDetail.getByText("Cleanup needs attention", { exact: true }).waitFor();
	const raceReport = await readReport(raceDetail);
	assert.equal(raceReport.operation.status, "cleanup_failed", "late snapshot must not overwrite pushed outcome");
	assert.ok(raceReport.events.some(event => event.message === "Browser-only cleanup evidence"));
	assert.ok(raceReport.events.some(event => event.eventType === "transfer_created"), "snapshot history must merge with the pushed event");
	assert.equal(await racePage.getByRole("textbox", { name: "Search loaded operations" }).inputValue(), "1");
	assert.equal(await racePage.locator(".se-history .ant-pagination-item-active").getAttribute("title"), "2");
	assert.equal(raceReport.transferId, "browser-record-00", "live updates preserve the selection even on another page");
	assert.ok(latestResponse && routeHandle);
	console.log("PASS real request retry and log-push/snapshot race");
	const summaryPage = await browser.newPage();
	await summaryPage.routeWebSocket(/api\/socket/, socket => {
		const wire = connectHistory(socket);
		let injected = false;
		wire.server.onMessage(raw => {
			const frame = JSON.parse(String(raw)); wire.replace(frame);
			if (injected && typeof frame.seq === "number") frame.seq++;
			if (!injected && frame.type === "response" && frame.data?.events) {
				injected = true;
				socket.send(JSON.stringify({ type: "event", seq: frame.seq, src: frame.src, dst: frame.dst.slice(0, 2),
					name: "surface_export:SurfaceExportTransferUpdateEvent", data: { revision: 900001, generatedAt: Date.now(),
						transfer: { ...frame.data.transferInfo, status: "cleanup_failed", failedAt: Date.now(), lastEventAt: Date.now() },
					} }));
				frame.seq++;
			}
			socket.send(JSON.stringify(frame));
		});
	});
	await signIn(summaryPage);
	await summaryPage.getByTestId("transfer-detail").getByText("Cleanup needs attention", { exact: true }).waitFor();
	assert.equal((await readReport(summaryPage.getByTestId("transfer-detail"))).operation.status, "cleanup_failed");
	console.log("PASS summary-only live update is not overwritten by older details");
	const reconnectPage = await browser.newPage();
	let reconnectSocket;
	await reconnectPage.routeWebSocket(/api\/socket/, socket => {
		reconnectSocket = socket;
		const wire = connectHistory(socket);
		wire.server.onMessage(raw => { const frame = JSON.parse(String(raw)); wire.replace(frame); socket.send(JSON.stringify(frame)); });
	});
	await signIn(reconnectPage);
	const reconnectDetail = reconnectPage.getByTestId("transfer-detail");
	await reconnectDetail.getByText("Arrived and verified", { exact: true }).waitFor();
	history[0].detail.summary.validation.success = false;
	history[0].detail.summary.validation.itemCountMatch = false;
	await reconnectSocket.close({ code: 1012, reason: "Browser-only reconnect check" });
	await reconnectDetail.getByText("Completed; audit reported a failure", { exact: true }).waitFor();
	assert.equal((await readReport(reconnectDetail)).summary.validation.success, false);
	console.log("PASS reconnect refreshes selected evidence without a page reload");
	console.log(`Isolated ${isolatedLiveUpdates} real-cluster log/transfer updates from fixture history`);
	assert.deepEqual(errors, [], "no browser runtime errors");
} catch (error) {
	const pages = [];
	for (const context of browser.contexts()) for (const page of context.pages()) {
		pages.push(await page.evaluate(() => ({ url: location.href,
			body: document.body.innerText.slice(0, 2000),
			selected: document.querySelector(".se-history-row.is-selected")?.getAttribute("data-transfer-id"),
			rows: [...document.querySelectorAll(".se-history-row")].map(row => row.getAttribute("data-transfer-id")),
			detail: document.querySelector('[data-testid="transfer-detail"]')?.textContent,
		})));
	}
	mkdirSync("ci-artifacts", { recursive: true });
	const diagnostics = { error: String(error), errors, isolatedLiveUpdates, pages };
	writeFileSync("ci-artifacts/log-evidence-failure.json", JSON.stringify(diagnostics, null, 2));
	console.error(JSON.stringify(diagnostics));
	throw error;
} finally { await browser.close(); }
