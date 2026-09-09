import assert from "node:assert/strict";
import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {createHash} from "node:crypto";
import {lua,preflightState,assertLeaseClean} from "../../lab-gallery/batch-lifecycle.mjs";
import {withWorkflowLock} from "../../../tools/shared/workflow-lock.mjs";
const source=readFileSync(new URL("./observe.lua",import.meta.url),"utf8");
const hash=createHash("sha256").update(source).update(readFileSync(new URL(import.meta.url)));
for(const file of ["import_phases/active_state_restoration.lua","validators/cargo-counter.lua"]){
    hash.update(readFileSync(new URL("../../../docker/seed-data/external_plugins/surface_export/module/"+file,import.meta.url)));
}
const digest=hash.digest("hex");
const name="activation-audit-"+Date.now();
await withWorkflowLock(async()=>{
    assertLeaseClean(1,preflightState(1),"activation audit");
    const output={hash:digest,engine:"2.1.17",results:[]};
    for(const inject of [true,false]){
        const result=lua(1,`local AUDIT_NAME="${name}" local INJECT_CLEANUP=${inject} ${source}`);
        output.results.push(result);
        mkdirSync("ci-artifacts",{recursive:true});
        writeFileSync("ci-artifacts/post-activation-live.json",JSON.stringify(output,null,2));
        assert.equal(result.cleanupQueued,true,"fixture cleanup must be queued");
        // delete_surface queues deletion; prove absence in the next RCON callback.
        const cleanup=lua(1,`return {absent=game.surfaces["${name}"]==nil,version=script.active_mods.base}`);
        assert.equal(cleanup.version,output.engine);
        assert.equal(cleanup.absent,true,"fixture cleanup must complete");
        result.cleanupVerified=true;
        writeFileSync("ci-artifacts/post-activation-live.json",JSON.stringify(output,null,2));
        if(inject){assert.equal(result.success,false);assert.match(result.error,/injected construction stop/);}
        else assert.equal(result.success,true,result.error);
    }
    assertLeaseClean(1,preflightState(1),"activation audit postflight");
    console.log("PASS activation preserves same-callback cargo; prior cargo check detects shortage; injected and normal cleanup passed");
});
