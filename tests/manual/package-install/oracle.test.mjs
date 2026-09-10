import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzePackage } from "./oracle.mjs";

const observed=JSON.parse(readFileSync(new URL("./evidence/installed-0.10.281.json",import.meta.url),"utf8"));
test("retained package-only live observation passes offline",()=>assert.equal(analyzePackage(observed).verdict,"PASS"));
test("package acceptance rejects failed installation, absent files and a checkout substituted for the installed runtime",()=>{
  for(const mutate of [r=>r.packageInstall.success=false,r=>r.packageInstall.version="0.9.82",
    r=>r.package.files=[],r=>r.package.sha256="",r=>r.environment.stagedHashes.plugin="0".repeat(64)]) {
    const r=structuredClone(observed);mutate(r);assert.throws(()=>analyzePackage(r));
  }
});
test("package acceptance retains independent cargo, replay and cleanup requirements",()=>{
  let r=structuredClone(observed);r.samples.at(-1).destination.cargo.entities.pop();
  assert.equal(analyzePackage(r).verdict,"STOP");
  r=structuredClone(observed);r.events[2].push(r.events[2].find(e=>e.action==="import"&&e.kind==="call"));
  assert.throws(()=>analyzePackage(r),/exactly one/);
  r=structuredClone(observed);r.cleanup.success=false;assert.throws(()=>analyzePackage(r),/cleanup/);
});
