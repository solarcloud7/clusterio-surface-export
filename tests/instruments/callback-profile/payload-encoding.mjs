import assert from "node:assert/strict";
import {readFileSync, writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {withWorkflowLock} from "../../../tools/shared/workflow-lock.mjs";
import {docker, HOSTS, preflightState, assertLeaseClean} from "../../lab-gallery/batch-lifecycle.mjs";

function analyze(report) {
  assert.equal(report.mutated, false);
  assert.equal(report.engine, "2.1.17");
  assert.ok(report.calls > 1 && report.calls <= 100);
  assert.deepEqual(JSON.parse(report.candidate), JSON.parse(report.original));
  return {verdict: "PASS", calls: report.calls, bytes: Buffer.byteLength(report.candidate)};
}
if (process.argv[2] === "--analyze") {
  console.log(analyze(JSON.parse(readFileSync(process.argv[3], "utf8"))));
} else await withWorkflowLock(async () => {
  assert.equal(process.argv.length, 2);
  const code = readFileSync(new URL("../../../docker/seed-data/external_plugins/surface_export/module/utils/payload-encoder.lua", import.meta.url), "utf8");
  const body = `
    assert(script.active_mods.base == '2.1.17');
    local require=function(path) return assert(package.loaded['__level__/'..path..'.lua']) end;
    local encoder=(function() ${code} end)();
    local payload={entities={},tiles={},empty={},enabled=false,number=1.23456789012345,
      label='quote" slash\\\\ newline\\n',nested={array={true,false,{},'Unicode: λ'},object={x=-1.2}}};
    for i=1,53 do payload.entities[i]={id=i,items={{name='iron-plate',count=i,quality='rare'}}} end;
    for i=1,2001 do payload.tiles[i]={name='space-platform-foundation',position={x=i,y=-i}} end;
    local original=helpers.table_to_json(payload);
    local job={export_data=payload};local result;local calls=0;
    repeat calls=calls+1;assert(calls<=100);result=encoder.process(job,50) until result;
    assert(helpers.table_to_json(payload)==original,'captured payload mutated');
    return {success=true,engine=script.active_mods.base,original=original,candidate=result,calls=calls}`;
  const file = `ci-artifacts/payload-encoding-${Date.now().toString(36)}.json`;
  const report = {mutated: false, encoderSha256: createHash("sha256").update(code).digest("hex"),
    observerSha256: createHash("sha256").update(body).digest("hex")};
  try {
    for (const host of [1, 2]) assertLeaseClean(host, preflightState(host), "payload encoding probe");
    const command = `/sc local ok,result=pcall(function() ${body} end);rcon.print(helpers.table_to_json(ok and result or {success=false,error=tostring(result)}))`;
    assert.ok(Buffer.byteLength(command) <= 32768);
    const output = docker(["exec", "surface-export-controller", "npx", "clusterioctl", "--config", "/clusterio/tokens/config-control.json",
      "--log-level", "error", "instance", "send-rcon", HOSTS[1].instance, command], {timeout: 20000, maxBuffer: 4194304});
    Object.assign(report, JSON.parse(output.trim().split(/\r?\n/).at(-1)));
    assert.equal(report.success, true, report.error);
    Object.assign(report, analyze(report));
  } catch (error) { report.verdict = "HARNESS_ERROR"; report.error = String(error); process.exitCode = 1; }
  finally { writeFileSync(file, JSON.stringify(report)); console.log({verdict: report.verdict, error: report.error, artifact: file}); }
});
