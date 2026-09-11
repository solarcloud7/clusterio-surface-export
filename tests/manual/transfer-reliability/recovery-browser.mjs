import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

export async function recoveryBrowser(lab,report,{restartRequired=false}={}) {
  const {chromium}=await import("playwright");
  assert.match(lab.url,/^http:\/\/127\.0\.0\.1:\d+$/,"only owned loopback lab allowed");
  const token=JSON.parse(lab.docker(["exec",lab.controller,"cat","/clusterio/tokens/config-control.json"]))["control.controller_token"];
  const browser=await chromium.launch({headless:true});
  const evidence={errors:[],warnings:false,dialog:false,restartRequired:false};
  let page;
  try {
    page=await browser.newPage({viewport:{width:1600,height:1100}});page.setDefaultTimeout(30000);
    page.on("pageerror",error=>evidence.errors.push(error.message));
    await page.goto(lab.url);await page.evaluate(value=>localStorage.setItem("controller_token",value),token);
    if(report.mode) {
      await page.goto(`${lab.url}/surface-export?tab=gateways`);
      const warning=page.getByTestId("save-recovery-warning").filter({hasText:report.name});
      await warning.waitFor();
      const wording=report.mode==="save_game"?"accepted this restored copy":"remains protected";
      assert.ok((await warning.innerText()).includes(wording));evidence.warnings=true;
      await page.screenshot({path:join(lab.directory,"save-recovery-warning.png"),fullPage:true});
      await warning.getByRole("link",{name:"View transfer"}).click();
    } else await page.goto(`${lab.url}/surface-export?tab=logs&transfer=${encodeURIComponent(report.transferId)}`);
    const detail=page.getByTestId("transfer-detail");
    await detail.getByRole("heading",{name:report.name,exact:true}).waitFor();
    await detail.getByRole("button",{name:"Restore from snapshot",exact:true}).click();
    const modal=page.getByRole("dialog");await modal.getByText("Restore from snapshot",{exact:true}).waitFor();
    assert.ok((await modal.innerText()).includes("Another copy may already exist"));
    assert.equal(await modal.getByRole("button",{name:"Restore platform",exact:true}).isDisabled(),true,"destination must be chosen");
    await page.screenshot({path:join(lab.directory,"restore-snapshot-dialog.png")});
    await modal.getByRole("button",{name:"Cancel",exact:true}).click();evidence.dialog=true;
    await page.goto(`${lab.url}/surface-export?tab=settings`);
    await page.getByLabel("Platform source of truth",{exact:true}).waitFor();
    if(restartRequired) {await page.getByText(/restart required/).first().waitFor();evidence.restartRequired=true;}
    await page.screenshot({path:join(lab.directory,"recovery-settings.png"),fullPage:true});
    assert.deepEqual(evidence.errors,[]);return evidence;
  } catch(error) {
    if(page) {
      await page.screenshot({path:join(lab.directory,"recovery-browser-failure.png"),fullPage:true})
        .catch(captureError=>evidence.errors.push(`Screenshot unavailable: ${captureError.message}`));
      const body=await page.locator("body").innerText().catch(captureError=>`Page text unavailable: ${captureError.message}`);
      writeFileSync(join(lab.directory,"recovery-browser-failure.txt"),JSON.stringify(evidence)+"\n"+body.slice(0,24000));
    }
    throw error;
  } finally {await browser.close();}
}
