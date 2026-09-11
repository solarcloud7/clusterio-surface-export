import test from "node:test";
import assert from "node:assert/strict";
import { restoreConfiguration } from "./restore.mjs";
import { PRODUCTION_VOLUME_SUFFIXES, validateStorageRequest } from "../transfer-reliability/backup-storage.mjs";

const run="se-manual-production-offline";
const configuration=()=>({name:run,services:{controller:{container_name:`${run}-controller`},"host-1":{},"host-2":{}},
  volumes:Object.fromEntries(PRODUCTION_VOLUME_SUFFIXES.map(key=>[key,{name:`${run}-${key}`,external:key==="client"}])),
  networks:{default:{name:run}}});
test("restore uses fresh owned resources and cannot target the original Compose project",()=>{
  const config=configuration(),before=structuredClone(config),next=restoreConfiguration(config,run);
  assert.deepEqual(config,before);assert.notEqual(next.name,config.name);
  assert.deepEqual(next.networks.default,{name:run,external:true});
  for(const [key,volume] of Object.entries(next.volumes)) {
    assert.notEqual(volume.name,config.volumes[key].name);assert.equal(volume.external,undefined);
    assert.equal(volume.labels["surface-export.manual-run"],run);
    assert.doesNotThrow(()=>validateStorageRequest("backup",key,run,"","production"));
  }
  for(const value of Object.values(next.services)) assert.ok(value.container_name.startsWith(`${run}-restored-`));
});
test("new or missing persistent stores fail before restore, as do foreign resource names",()=>{
  for(const mutate of [c=>delete c.volumes.tokens,c=>c.volumes.unknown={},c=>delete c.volumes.client]) {
    const config=configuration();mutate(config);assert.throws(()=>restoreConfiguration(config,run));
  }
  assert.throws(()=>restoreConfiguration(configuration(),"surface-export"));
});
