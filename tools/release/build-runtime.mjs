import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyPackage } from "./verify-package.mjs";
import { withWorkflowLock } from "../shared/workflow-lock.mjs";

const pins = JSON.parse(readFileSync(new URL("../../docker/production/pins.json", import.meta.url)));
const { bases } = pins;
export const buildFiles = ["Dockerfile", "pins.json", "verify-gateway.cjs", "verify-install.cjs", "start.sh",
  "configure.cjs", "configure-host.cjs", "configure-controller.cjs", "wire-startup.cjs", "settings.json"];
export function buildIdentity(directory, role, base) {
  const hash = createHash("sha256").update(JSON.stringify({ role, base }));
  for (const file of [...buildFiles, "package.tgz", "gateway.zip"]) hash.update(file + "\0").update(readFileSync(join(directory, file)));
  return hash.digest("hex");
}
export function buildRuntime({ artifact, commit, version, gateway, gatewaySha256, output }) {
  const accepted = verifyPackage(resolve(artifact), { commit, version });
  assert.match(gatewaySha256, /^[a-f0-9]{64}$/);
  assert.equal(createHash("sha256").update(readFileSync(gateway)).digest("hex"), gatewaySha256, "gateway hash mismatch");
  assert.ok(!existsSync(output), "output must be a new directory");
  mkdirSync(output, { recursive: true });
  for (const file of buildFiles)
    copyFileSync(new URL(`../../docker/production/${file}`, import.meta.url), join(output, file));
  copyFileSync(join(artifact, "package.tgz"), join(output, "package.tgz"));
  copyFileSync(gateway, join(output, "gateway.zip"));
  const result = { schemaVersion: 1, accepted, gatewaySha256, pins, bases, images: {}, buildIdentities: {} };
  for (const role of ["controller", "host"]) {
    const identity = result.buildIdentities[role] = buildIdentity(output, role, bases[role]);
    const tag = `surface-export-${role}:${identity}`;
    execFileSync("docker", ["build", "--build-arg", `BASE_IMAGE=${bases[role]}`, "--build-arg", `ROLE=${role}`,
      "--build-arg", `PACKAGE_SHA256=${accepted.sha256}`, "--build-arg", `GATEWAY_SHA256=${gatewaySha256}`,
      "--tag", tag, output], { stdio: "inherit", timeout: 600_000 });
    result.images[role] = execFileSync("docker", ["image", "inspect", tag, "--format", "{{.Id}}"], { encoding: "utf8" }).trim();
  }
  writeFileSync(join(output, "runtime.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [artifact, commit, version, gateway, gatewaySha256, output, ...rest] = process.argv.slice(2);
  if (!output || rest.length) {
    console.log("node tools/release/build-runtime.mjs <accepted-artifact-dir> <accepted-commit> <version> <gateway.zip> <gateway-sha256> <new-output-dir>");
    process.exitCode = 1;
  } else await withWorkflowLock(async () => console.log(JSON.stringify(buildRuntime({ artifact, commit, version, gateway, gatewaySha256, output }), null, 2)));
}
