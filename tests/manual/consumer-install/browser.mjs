import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { chromium } from "playwright";

export async function browserAcceptance(lab, report) {
  const token = JSON.parse(lab.docker(["exec", lab.controller, "cat", lab.controlConfig || "/consumer/config-control.json"]))["control.controller_token"];
  assert.ok(token, "disposable admin token missing");
  const browser = await chromium.launch({ headless: true });
  const evidence = { assets: [], pageErrors: [], failedResponses: [], nodes: [] };
  report.browser = evidence;
  const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });
  page.setDefaultTimeout(30_000);
  page.on("pageerror", error => evidence.pageErrors.push(error.message));
  page.on("response", response => {
    if (response.status() >= 400 && response.url().startsWith(lab.url) && !response.url().endsWith("/favicon.ico"))
      evidence.failedResponses.push({ path: new URL(response.url()).pathname, status: response.status() });
  });
  try {
    await page.goto(lab.url);
    await page.evaluate(value => localStorage.setItem("controller_token", value), token);
    await page.goto(`${lab.url}/surface-export?tab=gateways`);
    await page.waitForFunction(() => {
      const nodes = [...document.querySelectorAll(".react-flow__node-instance")];
      return nodes.length === 2 && nodes.every(node => getComputedStyle(node).visibility === "visible"
        && node.getBoundingClientRect().width > 0);
    });
    evidence.nodes = await page.locator(".react-flow__node-instance").evaluateAll(nodes => nodes.map(node => ({ id: node.dataset.id, text: node.textContent })));
    assert.deepEqual(evidence.nodes.map(n => n.id).sort(), Object.values(lab.ids).map(id => `instance:${id}`).sort());
    await page.screenshot({ path: join(lab.directory, "gateways.png") });
    for (const [name, file] of Object.entries(lab.assets)) {
      assert.match(file, /^[\w.-]+$/, "unsafe exported asset filename");
      const response = await page.request.get(`${lab.url}/static/${file}`, { timeout: 30_000 });
      assert.equal(response.status(), 200, `missing exported ${name}`);
      const body = await response.body();
      assert.ok(body.length > 0, `empty ${name}`);
      const asset = { name, file, status: response.status(), bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") };
      if (file.endsWith(".png")) {
        assert.equal(body.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "invalid icon sheet");
        asset.png = true;
      } else if (file.endsWith(".json")) {
        const data = JSON.parse(body.toString("utf8"));
        asset.entries = Object.keys(data).length;
        assert.ok(asset.entries > 0, `empty exported ${name}`);
        if (name === "prototypes") {
          const locations = Object.values(data["space-location"] || {}).filter(p => p.name.startsWith("surfexp_gateway_"));
          evidence.visibleGateways = locations.filter(p => !p.hidden).map(p => p.name).sort();
          evidence.gatewayRoutes = Object.values(data["space-connection"] || {}).filter(p => p.to === "surfexp_gateway_hub").map(p => p.from).sort();
          assert.deepEqual(evidence.visibleGateways, ["surfexp_gateway_hub"]);
          assert.deepEqual(evidence.gatewayRoutes, ["aquilo", "fulgora", "gleba", "nauvis", "vulcanus"]);
        }
      }
      evidence.assets.push(asset);
    }
    assert.ok(evidence.assets.some(a => /locale/.test(a.name) && a.entries > 0), "locale export missing");
    assert.ok(evidence.assets.some(a => /metadata/.test(a.name) && a.entries > 0), "icon metadata export missing");
    assert.ok(evidence.assets.some(a => a.png), "icon sheet missing");
    await page.getByRole("tab", { name: "Transaction Logs", exact: true }).click();
    await page.getByRole("heading", { name: "Transfer history", exact: true }).waitFor();
    await page.getByText(report.recovery.name, { exact: true }).first().waitFor();
    evidence.transferVisible = true;
    await page.screenshot({ path: join(lab.directory, "transfer-logs.png") });
    assert.deepEqual(evidence.pageErrors, []);
    assert.deepEqual(evidence.failedResponses, []);
    evidence.success = true;
  } finally { await browser.close(); }
}
