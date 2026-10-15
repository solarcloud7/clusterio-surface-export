import assert from "node:assert/strict";
import { analyze } from "../transfer-reliability/oracle.mjs";

export function analyzePackage(report) {
  assert.equal(report.packageInstall?.success,true,"package installation unavailable");
  assert.equal(report.package?.name,"@solarcloud7/plugin-surface-export");
  assert.equal(report.package.version,report.packageInstall.version,"installed package version differs");
  assert.equal(report.packageInstall.coreVersion,report.runtime?.clusterioVersion ?? "2.0.0-alpha.27","installed core version differs from the pinned image");
  if(report.packageInstall.peers) for(const name of ["controller","lib"]) assert.equal(report.packageInstall.peers[name],report.packageInstall.coreVersion,`@clusterio/${name} differs from the core version`);
  assert.match(report.package.sha256,/^[a-f0-9]{64}$/,"tarball hash unavailable");
  assert.match(report.packageInstall.treeHash,/^[a-f0-9]{64}$/,"installed tree hash unavailable");
  assert.equal(report.environment?.stagedHashes.plugin,report.packageInstall.treeHash,"lab used another runtime");
  for(const file of ["dist/node/index.js","dist/web/manifest.json","module/module.json"])
    assert.ok(report.package.files.includes(file),`required packed file missing: ${file}`);
  return analyze(report);
}
