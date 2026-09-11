import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runCommand } from "../shared/command-evidence.mjs";
import configuration from "../../docker/production/configure.cjs";
import { pins } from "../../docker/production/provision.mjs";

export const contract = { requires: ["candidate image IDs", "Docker"], produces: ["verified native CLI results", "cleanup evidence"],
  "does not": ["start the deployment", "modify existing containers or volumes"] };
export function expectations(role) {
  return { version: pins.clusterio, settings: configuration.settingsForRole(role),
    plugins: [["surface_export", "@solarcloud7/plugin-surface-export"]] };
}
export function validatePreflight(output, role) {
  const value = JSON.parse(output), expected = expectations(role);
  assert.deepEqual(value, { schemaVersion: 1, role, ...expected, localConfig: "verified" });
  return value;
}
export function preflightRuntime(runtime, evidenceFile, { command = runCommand, identity = randomUUID } = {}) {
  const results = [];
  const run = "se-manual-cli-" + identity();
  assert.match(run, /^se-manual-cli-[a-z0-9-]{8,60}$/);
  for (const role of ["controller", "host"]) {
    const image = runtime.images[role];
    assert.match(image, /^sha256:[a-f0-9]{64}$/);
    const name = run + "-" + role;
    const docker = args => command("docker", args, { label: "cli-preflight-" + role, evidenceFile,
      timeout: 90000 }).stdout.trim();
    const script = fileURLToPath(new URL("cli-preflight.cjs", import.meta.url));
    let primary, verified;
    const cleanup = { success: false, errors: [] };
    try {
      docker(["create", "--name", name, "--label", "surface-export.manual-run=" + run, "--network", "none",
        "--user", "clusterio", "--mount", "type=bind,src=" + script + ",dst=/preflight.cjs,readonly",
        "--entrypoint", "node", image, "/preflight.cjs", role, JSON.stringify(expectations(role))]);
      verified = validatePreflight(docker(["start", "-a", name]), role);
    } catch (error) { primary = error; }
    finally {
      try {
        const names = docker(["ps", "-a", "--filter", "label=surface-export.manual-run=" + run, "--format", "{{.Names}}"])
          .split(/\r?\n/).filter(Boolean);
        for (const owned of names) {
          try {
            assert.equal(owned, name, "unexpected resource in preflight ownership set");
            assert.equal(docker(["container", "inspect", owned, "--format", '{{ index .Config.Labels "surface-export.manual-run" }}']), run);
            docker(["rm", "-f", owned]);
          } catch (error) { cleanup.errors.push(error.message); }
        }
        assert.equal(docker(["ps", "-aq", "--filter", "label=surface-export.manual-run=" + run]), "", "preflight resources remain");
      } catch (error) { cleanup.errors.push(error.message); }
      cleanup.success = cleanup.errors.length === 0;
    }
    if (primary || !cleanup.success) {
      const error = new Error([primary?.message, ...cleanup.errors].filter(Boolean).join("; "), { cause: primary });
      error.preflight = { role, image, cleanup };
      error.evidence = primary?.evidence;
      throw error;
    }
    results.push({ image, ...verified, cleanup });
  }
  return results;
}
