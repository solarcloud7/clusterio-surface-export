// Loaded only into disposable host containers through NODE_OPTIONS. Never shipped in the plugin.
"use strict";
const fs = require("node:fs"), Module = require("node:module");
const run = process.env.SE_MANUAL_RUN;
if (!/^se-manual-[a-z0-9-]{8,60}$/.test(run || "")) throw new Error("Manual fault hook requires disposable run identity");
const originalLoad = Module._load, patched = Symbol.for("surface-export.manual-fault-hook");
const path = "/clusterio/data/manual-fault.json", events = "/clusterio/data/manual-events.jsonl";
const consumed = new Set();
const readRule = () => fs.existsSync(path) ? JSON.parse(fs.readFileSync(path,"utf8")) : {};
const record = event => fs.appendFileSync(events,JSON.stringify({run,pid:process.pid,utc:new Date().toISOString(),...event})+"\n");
Module._load = function(request, parent, isMain) {
  const result = originalLoad.apply(this,arguments);
  if (!result?.InstancePlugin || !String(Module._resolveFilename(request,parent,isMain)).replaceAll("\\","/").endsWith("/surface_export/dist/node/instance.js")) return result;
  const proto=result.InstancePlugin.prototype;
  if(proto[patched]) return result;
  proto[patched]=true;
  for (const [method,action] of [["handleDeleteSourcePlatformMeasured","source"],["handleDestinationTransferGate","destination"],["handleImportPlatformRequestMeasured","import"]]) {
    const original=proto[method];
    if(typeof original!=="function") throw new Error(`Manual interception missing ${method}`);
    proto[method]=async function(req) {
      const id=String(req.transferId || req.exportId || req.exportData?._transferId || "");
      const scoped=id.includes(`transfer-cleanup-${run}-`);
      if(scoped) record({kind:"call",action,id,gate:req.action});
      const response=await original.call(this,req);
      const rule=readRule();
      if(scoped && response?.success===true && rule.run===run && rule.enabled===true
        && rule.action===action && id.includes(rule.name) && !consumed.has(rule.name)
        && (action!=="destination" || req.action==="go_live")) {
        consumed.add(rule.name);
        record({kind:"response-held",action,id,name:rule.name,success:true});
        // Do not fabricate an error or success. The driver disconnects the requester.
        // This old handler never returns; a later retry uses the real receipt path.
        return new Promise(()=>{});
      }
      if(scoped) record({kind:"return",action,id,gate:req.action,success:response?.success===true});
      return response;
    };
  }
  return result;
};
