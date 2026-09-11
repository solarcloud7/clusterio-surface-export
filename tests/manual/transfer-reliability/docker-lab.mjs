import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { seededInstances } from "../../../tools/shared/seeded-instances.mjs";

export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const PLUGIN = join(ROOT, "docker/seed-data/external_plugins/surface_export");
const LABEL = "surface-export.manual-run";
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
export function hashTree(directory) {
  const digest=createHash("sha256");
  const visit=(path,prefix="")=>{
    for(const entry of readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,"en"))) {
      const name=prefix+entry.name;
      assert.ok(!entry.isSymbolicLink(),"runtime staging cannot contain links");
      if(entry.isDirectory()) visit(join(path,entry.name),`${name}/`);
      else digest.update(`${name}\0${hash(join(path,entry.name))}\n`);
    }
  };
  visit(directory);return digest.digest("hex");
}
export function validRun(run) { return /^se-manual-[a-z0-9-]{8,60}$/.test(run); }

export class DockerLab {
  constructor(run, directory, {sameSourceSave = false, sectionedCodec = false, packageDirectory = null} = {}) {
    assert.ok(validRun(run), "invalid disposable run identity");
    this.run = run; this.directory = directory; this.sameSourceSave = sameSourceSave; this.sectionedCodec = sectionedCodec;
    this.packageDirectory = packageDirectory;
    this.network = run; this.controller = `${run}-controller`;
    this.hosts = Object.fromEntries(seededInstances().map(h => [h.hostNumber,
      {...h, container: `${run}-host-${h.hostNumber}`} ]));
    assert.equal(Object.keys(this.hosts).length, 2);
    this.containers = []; this.volumes = []; this.networkCreated = false;
    this.deadline = Date.now() + 600_000;
  }
  docker(args, options = {}) {
    if (!this.cleaning && this.cancelled) throw new Error("Manual lab interrupted");
    if (!this.cleaning && Date.now() > this.deadline) throw new Error("Disposable lab deadline exceeded");
    try { return execFileSync("docker", args, {encoding:"utf8", timeout:30_000, maxBuffer:1048576,
      stdio:["pipe","pipe","pipe"], ...options}); }
    catch (error) { throw new Error(`docker ${args[0]} failed: ${String(error.stderr || error.message).slice(-1600)}`); }
  }
  async until(read, label, seconds = 120) {
    const end = Date.now() + seconds * 1000;
    let last;
    while (Date.now() < end) {
      if(this.cancelled || Date.now()>this.deadline) throw new Error("Manual lab interrupted or deadline exceeded");
      try { const value = read(); if (value) return value; } catch (error) { last = error.message; }
      await sleep(1000);
    }
    throw new Error(`${label} timed out${last ? `: ${last}` : ""}`);
  }
  assertOwned(kind, name) {
    assert.ok(name === this.run || name.startsWith(`${this.run}-`), "foreign resource name");
    const [info] = JSON.parse(this.docker([kind, "inspect", name]));
    const labels = kind === "container" ? info.Config.Labels : info.Labels;
    assert.equal(labels?.[LABEL], this.run, "refuse foreign Docker resource");
  }
  mutateContainer(verb, name, extra = []) {
    this.assertOwned("container", name);
    return this.docker([verb, ...extra, name], {timeout:60_000});
  }
  ctl(...args) {
    return this.docker(["exec", this.controller, "npx", "clusterioctl", "--log-level", "error",
      "--config", "/clusterio/tokens/config-control.json", ...args]);
  }
  lua(host, body) {
    const command = `/sc local ok,r=pcall(function() ${body} end);rcon.print(helpers.table_to_json(ok and r or {success=false,error=tostring(r)}))`;
    assert.ok(Buffer.byteLength(command) <= 32768, "RCON command bound");
    const raw = this.ctl("instance", "send-rcon", this.hosts[host].instance, command);
    const result = JSON.parse(raw.trim().split(/\r?\n/).at(-1));
    assert.equal(result.success, true, result.error || "Lua probe failed");
    return {result, raw};
  }
  probe(host, action, name) {
    const code = readFileSync(join(ROOT,"tests/integration/transfer-cleanup/probe.lua"),"utf8");
    return this.lua(host, `return (function() ${code} end)()('${action}','${name}')`).result;
  }
  async ready(seconds = 150) {
    return this.until(() => {
      for (const host of [1,2]) {
        const {result} = this.lua(host, `return {success=true,engine=script.active_mods.base,
          ready=remote.interfaces.surface_export~=nil,players=#game.connected_players,paused=game.tick_paused}`);
        assert.equal(result.engine,this.factorioVersion || "2.1.17"); assert.equal(result.players,0); assert.equal(result.paused,false);
        if (!result.ready) return false;
      }
      return true;
    }, "both disposable instances ready", seconds);
  }
  async setup() {
    mkdirSync(this.directory,{recursive:true});
    const tag = readFileSync(join(ROOT,".env.example"),"utf8").match(/^CLUSTERIO_IMAGE_TAG=(.+)$/m)?.[1].trim();
    assert.ok(tag && !tag.includes("latest"));
    this.image = `ghcr.io/solarcloud7/clusterio-docker-controller:${tag}`;
    this.hostImage = `ghcr.io/solarcloud7/clusterio-docker-host:${tag}`;
    const runtimeSource = this.packageDirectory || PLUGIN;
    for (const file of ["dist/node/index.js","dist/web/manifest.json"]) assert.ok(existsSync(join(runtimeSource,file)),"build or install plugin first");
    const seed = join(this.directory,"seed"), bundle = join(this.directory,"bundle/surface_export");
    mkdirSync(join(seed,"mods"),{recursive:true}); mkdirSync(bundle,{recursive:true});
    // Runtime artifact only: no git checkout, live node_modules, tokens, or owner .env.
    if (this.packageDirectory) {
      // Deliberately no checkout fallback: missing files must fail package acceptance.
      hashTree(runtimeSource); // Reject links before Docker sees a staged runtime.
      cpSync(runtimeSource,bundle,{recursive:true});
    } else {
      for (const part of ["dist","module","package.json","package-lock.json","scripts/prepare-build.mjs"])
        cpSync(join(PLUGIN,part),join(bundle,part),{recursive:true});
    }
    for (const h of Object.values(this.hosts)) {
      const source = join(ROOT,"docker/seed-data/hosts",h.host,h.instance), dest = join(seed,"hosts",h.host,h.instance);
      mkdirSync(dest,{recursive:true});
      const config = JSON.parse(readFileSync(join(source,"instance.json"),"utf8"));
      config["instance.auto_start"] = true;
      config["surface_export.sectioned_codec"] = this.sectionedCodec;
      config["factorio.settings"] = {...config["factorio.settings"], visibility:{public:false,lan:false},
        autosave_interval:0, auto_pause:false};
      writeFileSync(join(dest,"instance.json"),JSON.stringify(config,null,2));
      assert.equal(h.seededSaves.length,1,"one explicit seed save required");
      const reference = this.sameSourceSave
        ? JSON.parse(readFileSync(join(ROOT,"tests/lab-gallery/manifest.json"),"utf8")).saves.source : null;
      const saveSource = this.sameSourceSave
        ? join(ROOT,reference.artifact)
        : join(source,h.seededSaves[0]);
      if(reference) assert.equal(hash(saveSource).toUpperCase(),reference.sha256,"golden source hash mismatch");
      cpSync(saveSource,join(dest,h.seededSaves[0]));
    }
    this.stagedHashes={seed:hashTree(seed),plugin:hashTree(bundle)};
    this.docker(["network","create","--label",`${LABEL}=${this.run}`,this.network]); this.networkCreated=true;
    const volume = suffix => {
      const name=`${this.run}-${suffix}`;
      this.docker(["volume","create","--label",`${LABEL}=${this.run}`,name]); this.assertOwned("volume",name); this.volumes.push(name); return name;
    };
    const seedVolume=volume("seed"), plugins=volume("plugins"), tokens=volume("tokens"), data=volume("controller-data"), staticData=volume("static");
    const helper=`${this.run}-pack`;
    this.docker(["create","--name",helper,"--label",`${LABEL}=${this.run}`,"--entrypoint","/bin/sleep",
      "-v",`${seedVolume}:/seed`,"-v",`${plugins}:/plugins`,this.image,"infinity"]); this.containers.push(helper);
    this.docker(["cp",`${seed}/.`,`${helper}:/seed`],{timeout:90_000});
    this.docker(["cp",`${join(this.directory,"bundle")}/.`,`${helper}:/plugins`],{timeout:90_000});
    const common = name => ["run","-d","--name",name,"--label",`${LABEL}=${this.run}`,"--network",this.network];
    this.docker([...common(this.controller),"--hostname","clusterio-controller","--network-alias","clusterio-controller",
      "-e","HOST_COUNT=2","-e","EXPORT_HOST=0","-e","INIT_CLUSTERIO_ADMIN=manual-lab","-e","DEFAULT_MOD_PACK=Space Age 2.0",
      "-e","SE_SKIP_PREPARE=1","-v",`${data}:/clusterio/data`,"-v",`${staticData}:/clusterio/static`,
      "-v",`${tokens}:/clusterio/tokens`,"-v",`${seedVolume}:/clusterio/seed-data:ro`,
      "-v",`${join(ROOT,"docker/seed-data/mods")}:/clusterio/seed-data/mods:ro`,"-v",`${plugins}:/clusterio/external_plugins`,this.image]);
    this.containers.push(this.controller);
    await this.until(() => this.docker(["exec",this.controller,"curl","-sf","http://localhost:8080/"]).length > 0,"controller HTTP",180);
    for (const host of [1,2]) {
      const h=this.hosts[host];
      this.docker([...common(h.container),"--hostname",h.host,"-e",`HOST_NAME=${h.host}`,"-e","SKIP_CLIENT=true",
        "-e","CONTROLLER_URL=http://clusterio-controller:8080/","-e","SE_SKIP_PREPARE=1","-e",`SE_MANUAL_RUN=${this.run}`,
        "-e","NODE_OPTIONS=--require=/lab/fault-hook.cjs","-v",`${volume(`host-${host}-data`)}:/clusterio/data`,
        "-v",`${tokens}:/clusterio/tokens:ro`,"-v",`${join(ROOT,"docker/seed-data/mods")}:/clusterio/seed-mods:ro`,
        "-v",`${plugins}:/clusterio/external_plugins`,"-v",`${fileURLToPath(new URL("./",import.meta.url))}:/lab:ro`,this.hostImage]);
      this.containers.push(h.container);
    }
    await this.ready(360);
    this.preflight={};
    for(const host of [1,2]) {
      this.lua(host,`assert(table_size(storage.async_jobs or {})==0,'active seed jobs');
        assert(table_size(storage.locked_platforms or {})==0,'seed locks');
        assert(table_size(storage.destination_holds or {})==0,'seed holds');return {success=true}`);
      this.preflight[host]=this.probe(host,"world",`transfer-cleanup-${this.run}-preflight`);
      this.preflight[host].config=this.lua(host,"return {success=true,config=storage.surface_export_config}").result.config;
    }
    this.ids={};
    for (const host of [1,2]) {
      const out=this.ctl("instance","save","list",this.hosts[host].instance);
      const id=Number(out.match(/^\s*(\d+)\s*\|/m)?.[1]); assert.ok(Number.isSafeInteger(id)&&id>0);this.ids[host]=id;
    }
    return {controllerImage:this.image,hostImage:this.hostImage,ids:this.ids,preflight:this.preflight,stagedHashes:this.stagedHashes,
      images:JSON.parse(this.docker(["image","inspect",this.image,this.hostImage])).map(i=>({id:i.Id,digests:i.RepoDigests}))};
  }
  async checkpoint(name) {
    assert.match(name,/^manual-[a-z0-9-]+$/);
    for (const host of [1,2]) this.lua(host,`game.server_save('${name}');return {success=true}`);
    const evidence={};
    for (const host of [1,2]) {
      const file=`/clusterio/data/instances/${this.hosts[host].instance}/saves/${name}.zip`;
      evidence[host]=await this.until(() => this.docker(["exec",this.hosts[host].container,"node","-e",
        'const fs=require("fs"),zip=require("jszip"),crypto=require("crypto");const b=fs.readFileSync(process.argv[1]);zip.loadAsync(b,{checkCRC32:true}).then(()=>console.log(crypto.createHash("sha256").update(b).digest("hex"))).catch(e=>{console.error(e.message);process.exitCode=1;})',file]).trim(),"verified checkpoint",60);
    }
    return evidence;
  }
  async load(host,name,{crash=false}={}) {
    if (crash) { this.mutateContainer("kill",this.hosts[host].container,["--signal","KILL"]);
      this.mutateContainer("start",this.hosts[host].container);
      await this.until(()=>this.ctl("host","list").includes(this.hosts[host].host),"host reconnect",60);
      // Prevent automatic choice of a different save; config was disabled before this boundary.
    } else this.ctl("instance","stop",this.hosts[host].instance);
    await this.until(()=>{this.ctl("instance","start",this.hosts[host].instance,"--save",`${name}.zip`);return true;},"load checkpoint",90);
    await this.ready();
  }
  writeFault(host,rule) {
    this.assertOwned("container",this.hosts[host].container);
    this.docker(["exec","-i",this.hosts[host].container,"node","-e",
      'require("fs").writeFileSync("/clusterio/data/manual-fault.json",require("fs").readFileSync(0))'],{input:JSON.stringify(rule)});
  }
  events(host) {
    const raw=this.docker(["exec",this.hosts[host].container,"node","-e",
      'const f=require("fs"),p="/clusterio/data/manual-events.jsonl";if(f.existsSync(p))process.stdout.write(f.readFileSync(p))']);
    return raw.trim()?raw.trim().split("\n").map(line=>JSON.parse(line)):[];
  }
  ageRecoveryIntent(transferId) {
    this.assertOwned("container",this.controller);
    const [controller]=JSON.parse(this.docker(["container","inspect",this.controller]));
    assert.equal(controller.State.Running,false,"controller must be stopped before fault injection");
    const volume=`${this.run}-controller-data`;
    this.assertOwned("volume",volume);
    const name=`${this.run}-age-intent`;
    this.containers.push(name);
    const raw=this.docker(["run","--name",name,"--label",`${LABEL}=${this.run}`,"--network","none",
      "-v",`${volume}:/data`,"-v",`${join(ROOT,"tests/manual/transfer-reliability/age-intent.mjs")}:/age-intent.mjs:ro`,
      "node:24-bookworm-slim","node","/age-intent.mjs",transferId,this.run]);
    return JSON.parse(raw);
  }
  captureLogs(name,execute=spawnSync) {
    const limit=1048576;
    const result=execute("docker",["logs","--tail","1500",name],{timeout:30_000,maxBuffer:limit,stdio:["pipe","pipe","pipe"]});
    if(result.error && result.error.code!=="ENOBUFS") throw result.error;
    if(!result.error && result.status!==0) throw new Error(`docker logs failed: ${String(result.stderr).slice(-1600)}`);
    // Docker forwards container stderr on its own stderr even when `logs` succeeds.
    // Keep both streams, without implying they retain their original interleaving.
    const stdout=result.stdout||Buffer.alloc(0),stderr=result.stderr||Buffer.alloc(0);
    const marker=stderr.length?Buffer.from("\n--- stderr (separate stream) ---\n"):Buffer.alloc(0);
    const budget=limit-marker.length;
    // Reserve room for both tails; let a short stream donate its unused budget.
    // A full stdout buffer must not displace the fatal message on stderr.
    const stderrBytes=Math.min(stderr.length,Math.max(Math.floor(budget/2),budget-stdout.length));
    const stdoutBytes=Math.min(stdout.length,budget-stderrBytes);
    const tail=(bytes,count)=>count?bytes.subarray(-count):Buffer.alloc(0);
    const output=Buffer.concat([tail(stdout,stdoutBytes),marker,tail(stderr,stderrBytes)]);
    const truncated=result.error?.code==="ENOBUFS"||stdoutBytes<stdout.length||stderrBytes<stderr.length;
    writeFileSync(join(this.directory,`${name}.log`),output);
    return {container:name,bytes:output.length,truncated};
  }
  async cleanup() {
    this.cleaning=true; const errors=[],logs=[];
    // docker run can create a container before failing to start it. Discover by
    // exact owner label, then independently verify the name and label before removal.
    const discover = (kind,format) => this.docker(kind === "container"
      ? ["ps","-a","--filter",`label=${LABEL}=${this.run}`,"--format",format]
      : [kind,"ls","--filter",`label=${LABEL}=${this.run}`,"--format",format]).trim().split(/\r?\n/).filter(Boolean);
    try {
      this.containers=discover("container","{{.Names}}");
      this.volumes=discover("volume","{{.Name}}");
      this.networkCreated=discover("network","{{.Name}}").includes(this.network);
    } catch(error) {errors.push(`resource discovery: ${error.message}`);}
    for(const name of [...this.containers].reverse()) {
      try {
        this.assertOwned("container",name);
        logs.push(this.captureLogs(name));
      } catch(error) { errors.push(`logs/ownership ${name}: ${error.message}`); }
      try {this.mutateContainer("rm",name,["-f"]);} catch(error){errors.push(error.message);}
    }
    for(const name of this.volumes) try {this.assertOwned("volume",name);this.docker(["volume","rm",name]);}catch(error){errors.push(error.message);}
    if(this.networkCreated) try {this.assertOwned("network",this.network);this.docker(["network","rm",this.network]);}catch(error){errors.push(error.message);}
    for(const [kind,verb] of [["container","ps"],["volume","volume"],["network","network"]]) {
      const args=kind==="container"?[verb,"-aq"]:[verb,"ls","-q"];
      try {assert.equal(this.docker([...args,"--filter",`label=${LABEL}=${this.run}`]).trim(),"");}catch(error){errors.push(`${kind} cleanup: ${error.message}`);}
    }
    return {success:errors.length===0,errors,logs};
  }
}
