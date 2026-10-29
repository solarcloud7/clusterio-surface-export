#!/usr/bin/env python3
# requires: reviewed ZIP/hash, explicit Docker deployment profile, SSH/sudo, exclusive maintenance window with no players
# produces: read-only plan or published mod, coordinated backup, cloned mod packs and verified instance restarts
# does not: release/install the npm plugin, upgrade Factorio, reset saves, reopen firewalls or automatically roll back
import argparse
import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import uuid
import zlib

spec = importlib.util.spec_from_file_location("gateway_publisher", Path(__file__).with_name("publish-gateway-mod.py"))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate_profile(profile):
    require(profile.get("schema") == 1, "Expected deployment profile schema 1")
    for field in ("controller", "project"):
        require(re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*", profile.get(field, "")), f"Invalid {field}")
    ids = profile.get("instances", [])
    require(ids and all(type(i) is int and 0 <= i < 2**31 for i in ids) and len(set(ids)) == len(ids), "Explicit unique instance IDs required")
    require(profile.get("exportInstance") in ids, "exportInstance must be a selected instance")
    hosts = profile.get("hosts", [])
    require(hosts and len(set(hosts)) == len(hosts) and profile["controller"] not in hosts, "Unique host containers required")
    for host in hosts:
        require(isinstance(host, str) and re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*", host), "Invalid host container")
    for field in ("stackDirectory", "backupDirectory", "controlConfig"):
        value = profile.get(field, "")
        require(isinstance(value, str) and value.startswith("/") and value != "/" and ".." not in value.split("/"), f"Absolute {field} required")
    ssh = profile.get("ssh", [])
    require(isinstance(ssh, list) and all(isinstance(arg, str) and arg for arg in ssh), "ssh must be an argv array, or empty for local Docker")
    if ssh:
        require(Path(ssh[0]).stem.lower() == "ssh", "ssh must invoke the SSH client")
    return profile


def table_rows(output):
    lines = [line for line in output.splitlines() if "|" in line]
    require(lines, "Clusterio did not return an instance table")
    headings = [cell.strip() for cell in lines[0].split("|")]
    require({"id", "name", "status"} <= set(headings), "Unexpected instance table columns")
    rows = []
    for line in lines[1:]:
        cells = [cell.strip() for cell in line.split("|")]
        require(len(cells) == len(headings), "Ambiguous instance table row")
        rows.append(dict(zip(headings, cells)))
    return rows


def config_fields(output):
    result = {}
    for line in output.splitlines():
        key, separator, value = line.partition(" ")
        if separator and key in ("factorio.version", "factorio.mod_pack_id", "instance.auto_start", "surface_export.load_plugin"):
            result[key] = json.loads(value)
    require(len(result) == 4, "Missing required instance configuration fields")
    return result


def decode_pack(value):
    return json.loads(zlib.decompress(base64.b64decode(value.strip(), validate=True)))


def updated_pack(original, artifact, run_id):
    result = copy.deepcopy(original)
    mods = result.get("mods")
    require(isinstance(mods, list), "Unexpected mod-pack format")
    matches = [mod for mod in mods if mod.get("name") == publisher.MOD]
    require(len(matches) == 1 and matches[0].get("enabled", True), "Existing enabled gateway mod required")
    matches[0].update(version=artifact["version"], sha1=artifact["sha1"])
    result["name"] = f'{original["name"]} - gateway {artifact["version"]} - {run_id}'
    for key in ("id", "export_manifest", "updated_at_ms", "is_deleted"):
        result.pop(key, None)
    return result


IDLE = 'assert(#game.connected_players==0,"Players are connected"); assert(storage.source_recovery_ready,"Recovery is not ready"); assert(table_size(storage.async_jobs or {})==0,"Lua jobs remain"); assert(table_size(storage.destination_holds or {})==0,"Destination holds remain"); assert(table_size(storage.locked_platforms or {})==0,"Platform locks remain");'


class Deployment:
    def __init__(self, profile, runner=subprocess.run):
        self.profile = validate_profile(profile)
        self.runner = runner
        self.run_id = "gateway-" + uuid.uuid4().hex
        self.work = "/tmp/" + self.run_id
        self.backup = profile["backupDirectory"].rstrip("/") + "/" + self.run_id

    def command(self, argv, data=None, timeout=180):
        prefix = ["sudo", "-n"] if self.profile.get("sudo", True) else []
        argv = prefix + list(map(str, argv))
        if self.profile.get("ssh"):
            argv = self.profile["ssh"] + [shlex.join(argv)]
        result = self.runner(argv, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        require(result.returncode == 0, f"Deployment command {argv[0]} failed (exit {result.returncode}); no automatic retry or rollback")
        return result.stdout.decode("utf-8").strip()

    def node(self, script, *args, data=None):
        return self.command(["docker", "exec", "-i", self.profile["controller"], "node", "-e", script, *args], data=data)

    def ctl(self, *args):
        return self.command(["docker", "exec", "-w", self.work, self.profile["controller"], "npx", "--no-install", "clusterioctl",
                             "--log-level", "error", "--config", self.profile["controlConfig"], *args])

    def read_ctl(self, *args):
        return self.command(["docker", "exec", self.profile["controller"], "npx", "--no-install", "clusterioctl",
                             "--log-level", "error", "--config", self.profile["controlConfig"], *args])

    def lua(self, instance, body):
        raw = self.read_ctl("instance", "send-rcon", str(instance), '/sc local result=(function() ' + body + ' end)(); rcon.print(helpers.table_to_json(result))')
        return json.loads(raw)

    def inspect(self):
        containers = [self.profile["controller"], *self.profile["hosts"]]
        mounts = set()
        for name in containers:
            info = json.loads(self.command(["docker", "inspect", name, "--format",
                '{{json .State.Running}} {{json .Config.Labels}} {{json .Mounts}}']).replace("\n", " ").split(" ", 1)[1].split(" ", 1)[0]) if False else None
            running = self.command(["docker", "inspect", name, "--format", "{{.State.Running}}"])
            project = self.command(["docker", "inspect", name, "--format", '{{index .Config.Labels "com.docker.compose.project"}}'])
            require(running == "true" and project == self.profile["project"], f"Container {name} is not running in the selected project")
            records = json.loads(self.command(["docker", "inspect", name, "--format", "{{json .Mounts}}"] ))
            for mount in records:
                if mount["Type"] in ("volume", "bind"):
                    source = mount["Source"]
                    require(source.startswith("/") and source != "/" and ".." not in source.split("/"), "Unsafe backup source")
                    mounts.add(source)
        rows = table_rows(self.read_ctl("instance", "list"))
        require({int(row["id"]) for row in rows} == set(self.profile["instances"]), "Profile must include every instance in this controller; refresh inventory")
        instances = []
        for row in rows:
            require(row["status"] == "running", f'{row["name"]} is not running; inspect before deployment')
            instance = int(row["id"])
            config = config_fields(self.read_ctl("instance", "config", "list", str(instance)))
            require(config["surface_export.load_plugin"] is True, "Surface Export must be enabled")
            pack_id = config["factorio.mod_pack_id"]
            require(type(pack_id) is int, "Explicit mod-pack assignment required")
            pack = decode_pack(self.read_ctl("mod-pack", "export", str(pack_id)))
            state = self.lua(instance, IDLE + 'return {paused=game.tick_paused,engine=script.active_mods.base,mod=script.active_mods.surfexp_gateways,plugin=remote.call("surface_export","get_module_version")}')
            instances.append({"id": instance, "name": row["name"], "config": config, "pack": pack, "state": state})
        return {"instances": instances, "mounts": sorted(mounts), "containers": containers}

    def deploy(self, snapshot, data, artifact, record):
        self.node('require("fs").mkdirSync(process.argv[1],{mode:448});', self.work)
        self.command(["install", "-d", "-m", "700", self.backup])
        self.command(["test", "!", "-e", self.backup + "/deployment.tar"])
        record("quiescing", {"backup": self.backup})
        for row in snapshot["instances"]:
            self.lua(row["id"], IDLE + 'game.tick_paused=true; return {paused=game.tick_paused}')
        for row in snapshot["instances"]:
            self.lua(row["id"], IDLE + f'game.server_save("{self.run_id}"); return {{requested=true}}')
            self.read_ctl("instance", "config", "set", str(row["id"]), "instance.auto_start", "false")
            require(config_fields(self.read_ctl("instance", "config", "list", str(row["id"]))) ["instance.auto_start"] is False, "auto_start readback failed")
            self.read_ctl("instance", "stop", str(row["id"]))
            self.ctl("instance", "save", "download", str(row["id"]), self.run_id + ".zip")
            self.node('const fs=require("fs"),z=require("jszip");z.loadAsync(fs.readFileSync(process.argv[1]),{checkCRC32:true}).then(()=>fs.renameSync(process.argv[1],process.argv[2])).catch(()=>process.exitCode=1);',
                      self.work + "/" + self.run_id + ".zip", self.work + "/" + str(row["id"]) + ".zip")
        self.command(["docker", "stop", "--time", "90", *self.profile["hosts"], self.profile["controller"]], timeout=300)
        sources = sorted(set(snapshot["mounts"] + [self.profile["stackDirectory"]]))
        record("backing-up", {"sources": sources})
        self.command(["tar", "-C", "/", "-cpf", self.backup + "/deployment.tar", *[path.lstrip("/") for path in sources]], timeout=1800)
        self.command(["chmod", "600", self.backup + "/deployment.tar"])
        self.command(["tar", "-C", "/", "--compare", "-f", self.backup + "/deployment.tar"], timeout=1800)
        checksum = self.command(["sha256sum", self.backup + "/deployment.tar"]).split()[0]
        require(re.fullmatch("[0-9a-f]{64}", checksum), "Missing backup checksum")
        record("backed-up", {"sha256": checksum})
        self.command(["docker", "start", self.profile["controller"], *self.profile["hosts"]])
        import time
        deadline = time.monotonic() + 120
        while True:
            try:
                rows = table_rows(self.read_ctl("instance", "list"))
                if {int(row["id"]) for row in rows} == set(self.profile["instances"]) and all(row["status"] == "stopped" for row in rows):
                    break
            except (ValueError, json.JSONDecodeError):
                pass
            require(time.monotonic() < deadline, "Controller/instances not ready after backup; rollout stopped")
            time.sleep(2)
        filename = self.work + f'/{publisher.MOD}_{artifact["version"]}.zip'
        self.node('const fs=require("fs"),crypto=require("crypto"),b=fs.readFileSync(0);if(crypto.createHash("sha256").update(b).digest("hex")!==process.argv[2])throw Error("ZIP hash mismatch");fs.writeFileSync(process.argv[1],b,{mode:384});', filename, artifact["sha256"], data=data)
        self.ctl("mod", "upload", filename)
        packs = {}
        for row in snapshot["instances"]:
            old = row["config"]["factorio.mod_pack_id"]
            if old not in packs:
                desired = updated_pack(row["pack"], artifact, self.run_id)
                encoded = base64.b64encode(zlib.compress(json.dumps(desired).encode())).decode()
                output = self.ctl("mod-pack", "import", encoded)
                match = re.search(r"\((\d+)\)\s*$", output)
                require(match, "Mod-pack creation was not confirmed; do not retry blindly")
                packs[old] = int(match[1])
                require(decode_pack(self.ctl("mod-pack", "export", str(packs[old]))) == desired, "Mod-pack clone readback differs")
            self.ctl("instance", "config", "set", str(row["id"]), "factorio.mod_pack_id", str(packs[old]))
            require(config_fields(self.ctl("instance", "config", "list", str(row["id"]))) ["factorio.mod_pack_id"] == packs[old], "Mod-pack assignment readback failed")
        record("assigned", {"modPacks": packs})
        for pack_id in set(packs.values()):
            exporter = next(row["id"] for row in snapshot["instances"] if packs[row["config"]["factorio.mod_pack_id"]] == pack_id)
            require(exporter == self.profile["exportInstance"], "Multiple mod packs require explicit export hosts; rollout stopped")
            self.ctl("instance", "export-data", str(exporter))
        order = sorted(snapshot["instances"], key=lambda row: row["id"] != self.profile.get("canary", self.profile["exportInstance"]))
        for row in order:
            self.ctl("instance", "start", str(row["id"]), "--save", self.run_id + ".zip")
            observed = self.lua(row["id"], IDLE + 'return {paused=game.tick_paused,engine=script.active_mods.base,mod=script.active_mods.surfexp_gateways,plugin=remote.call("surface_export","get_module_version")}')
            require(observed == {**row["state"], "paused": True, "mod": artifact["version"]}, f'Runtime verification failed on {row["name"]}')
            record("verified-instance", {"id": row["id"], "versions": observed})
        for row in snapshot["instances"]:
            self.ctl("instance", "config", "set", str(row["id"]), "instance.auto_start", json.dumps(row["config"]["instance.auto_start"]))
            require(config_fields(self.ctl("instance", "config", "list", str(row["id"]))) ["instance.auto_start"] == row["config"]["instance.auto_start"], "auto_start restoration failed")
        for row in snapshot["instances"]:
            self.lua(row["id"], 'game.tick_paused=' + json.dumps(row["state"]["paused"]) + '; return {restored=true}')
        record("complete", {"modPacks": packs})


def main():
    parser = argparse.ArgumentParser(description="Publish an exact gateway ZIP and roll it out to a complete Docker-managed Clusterio deployment")
    parser.add_argument("profile", type=Path)
    parser.add_argument("zip", type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--apply", action="store_true", help="Publish and deploy; omission performs read-only preflight")
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    profile = validate_profile(json.loads(args.profile.read_text()))
    data, artifact = publisher.inspect_artifact(args.zip, args.version, args.sha256)
    deployment = Deployment(profile)
    snapshot = deployment.inspect()
    require(len({row["config"]["factorio.mod_pack_id"] for row in snapshot["instances"]}) == 1, "This rollout requires one shared mod pack; split-pack asset export needs a separate deployment")
    for row in snapshot["instances"]:
        updated_pack(row["pack"], artifact, deployment.run_id)
        require(row["state"]["engine"].startswith("2.1."), "Companion mod requires Factorio 2.1")
    args.evidence.mkdir(parents=True, exist_ok=False)
    os.chmod(args.evidence, 0o700)
    report = {"artifact": artifact, "snapshot": snapshot, "runId": deployment.run_id, "applied": args.apply, "events": []}
    def record(phase, value):
        report["events"].append({"phase": phase, **value})
        with open(args.evidence / "deployment.json", "w", encoding="utf-8") as stream:
            json.dump(report, stream, indent=2)
        os.chmod(args.evidence / "deployment.json", 0o600)
        print(phase, flush=True)
    record("preflight-passed", {"instances": [row["name"] for row in snapshot["instances"]]})
    if not args.apply:
        print(json.dumps({"status": "plan-only", "artifact": artifact, "instances": [row["name"] for row in snapshot["instances"]], "backup": deployment.backup}))
        return
    try:
        record("portal", {"status": publisher.publish(data, artifact, os.getenv("FACTORIO_MOD_PORTAL_API_KEY"))})
        current = deployment.inspect()
        require(current == snapshot, "Deployment changed during publication; rerun preflight")
        deployment.deploy(snapshot, data, artifact, record)
    except Exception:
        record("stopped-on-error", {"instruction": "Inspect the last phase and retain backup. No automatic rollback or resume was attempted."})
        raise


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"Gateway deployment stopped: {error}", file=sys.stderr)
        sys.exit(1)
