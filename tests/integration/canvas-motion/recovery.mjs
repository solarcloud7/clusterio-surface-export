import assert from 'node:assert/strict';

export async function checkRecoveryPreview(page) {
 await page.getByRole('button',{name:'Preview round trip',exact:true}).click();
 await page.getByRole('button',{name:'Pause',exact:true}).click();
 for(let step=0;step<8;step++)await page.getByRole('button',{name:'Next phase',exact:true}).click();
 const scene=page.getByTestId('transfer-motion-preview');
 await page.waitForFunction(()=>{
  const el=document.querySelector('[data-testid="transfer-motion-preview"] .surface-export-edge-status');
  return el && Math.abs(parseFloat(getComputedStyle(el).offsetDistance)-50)<.001;
 });
 const marker=scene.locator('.surface-export-edge-status');
 assert.match(await marker.getAttribute('title'),/cleanup needs attention/);
 assert.doesNotMatch(await marker.getAttribute('title'),/arrived|returned/);
 await page.waitForTimeout(10500);
 assert.equal(await marker.count(),1);
 assert.ok(Number(await marker.evaluate(el=>getComputedStyle(el).opacity))>0.1);
 await page.getByRole('button',{name:'Show queue',exact:true}).click();
 await page.waitForFunction(()=>{
  const el=document.querySelector('[data-testid="transfer-motion-preview"] .surface-export-edge-status');
  return el && parseFloat(getComputedStyle(el).offsetDistance)===100;
 });
 assert.match(await marker.getAttribute('title'),/queued/);
 await page.getByRole('button',{name:'Close',exact:true}).click();
}
