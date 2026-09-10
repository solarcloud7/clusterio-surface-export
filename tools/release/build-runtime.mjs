import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyPackage } from "./verify-package.mjs";
import { withWorkflowLock } from "../shared/workflow-lock.mjs";

const bases = {
  controller: "ghcr.io/solarcloud7/clusterio-docker-controller@sha256:bbbc25ec679905992a31a8da60b5be2f43ec56b809ff508ea5f8786977dd8c53",
  host: "ghcr.io/solarcloud7/clusterio-docker-host@sha256:98a66d7b39359408ebbb255ff44814b2920ab0fa30596a8a71a872b40df2e232",
};
export function buildRuntime({ artifact, commit, version, gateway, gatewaySha256, output }) {
  const accepted = verifyPackage(resolve(artifact), { commit, version });
  assert.match(gatewaySha256, /^[a-f0-9]{64}$/);
  assert.equal(createHash("sha256").update(readFileSync(gateway)).digest("hex"), gatewaySha256, "gateway hash mismatch");
  assert.ok(!existsSync(output), "output must be a new directory");
  mkdirSync(output, { recursive: true });
  for (const file of ["Dockerfile", "verify-install.cjs", "start.sh", "configure-host.cjs", "configure-controller.cjs", "wire-startup.cjs", "settings.json"])
    copyFileSync(new URL(`../../docker/production/${file}`, import.meta.url), join(output, file));
  copyFileSync(join(artifact, "package.tgz"), join(output, "package.tgz"));
  copyFileSync(gateway, join(output, "gateway.zip"));
  const result = { schemaVersion: 1, accepted, gatewaySha256, bases, images: {} };
  for (const role of ["controller", "host"]) {
    const tag = `surface-export-${role}:${accepted.sha256.slice(0, 16)}-${gatewaySha256.slice(0, 8)}`;
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
