import assert from "node:assert/strict";
import { sample, start, summary, terminal } from "./cases.mjs";
import { expectedCargo } from "../../integration/transfer-cleanup/oracle.mjs";

export const contract = { requires: ["owned disposable Docker lab", "debug_mode on both disposable instances for the fail-safe hooks"],
  produces: ["refused-unlock rollback observations before and after a controller restart", "release-rollback refusal evidence",
    "source release and fresh queue-admitted transfer with physical cargo samples"],
  "does not": ["restore saves", "repair cargo", "unlock or delete a copy by hand", "exercise a feature branch's belt-cargo restore"] };

const PENDING_FILE = "/clusterio/data/database/surface_export_pending_transfers.json";
const LOG_FILE = "/clusterio/data/database/surface_export_transaction_logs.json";
const CONFIG_KEYS = ["debug_mode", "test_force_validation_failure", "test_force_unlock_refusal"];

const readJson = (lab, file) => JSON.parse(lab.docker(["exec", lab.controller, "cat", file]).trim() || "[]");
export const readPending = lab => readJson(lab, PENDING_FILE);
export const readLogEntry = (lab, id) => readJson(lab, LOG_FILE).find(entry => entry.transferId === id);
export const eventTypes = entry => (entry?.events ?? []).map(event => event.eventType);
const configure = (lab, host, fields) => lab.lua(host, `remote.call('surface_export','configure',${fields});return {success=true}`);
const readConfig = (lab, host) => lab.lua(host,
  `local c=storage.surface_export_config or {};return {success=true,config={${CONFIG_KEYS.map(key => `${key}=c.${key}`).join(",")}}}`).result.config ?? {};
const sourceLocks = lab => lab.lua(1, "return {success=true,locks=table_size(storage.locked_platforms or {})}").result.locks;
const platformIndex = (lab, name) => lab.lua(1,
  `for _,p in pairs(game.forces.player.platforms) do if p.name=='${name}' then return {success=true,index=p.index} end end return {success=false,error='platform missing'}`).result.index;
const literal = value => value === undefined || value === null ? "nil" : typeof value === "number" ? String(value) : value === true ? "true" : "false";
const transferIds = lab => new Set(JSON.parse(lab.ctl("surface-export", "list-transfers", "200").trim().split(/\r?\n/).at(-1)).map(row => row.transferId));

function observe(lab, report, id) {
  const entry = readLogEntry(lab, id);
  return { ...sample(lab, report.name), history: summary(lab, id) ?? null, pending: readPending(lab), sourceLocks: sourceLocks(lab),
    events: eventTypes(entry), entryStatus: entry?.transferInfo?.status ?? null, entryError: entry?.transferInfo?.error ?? null };
}

export async function rollbackUnlockRefusedCase(lab, report, save) {
  report.name = `transfer-cleanup-${lab.run}-rollback-unlock-refused`;
  report.mutationOccurred = true;
  report.before = lab.probe(1, "build", report.name).state;
  assert.deepEqual(report.before.cargo, expectedCargo, "physical fixture differs from literal contract");
  report.initial = sample(lab, report.name);
  assert.equal(report.initial.destination.present, false, "destination fixture already exists");
  report.previousConfig = { 1: readConfig(lab, 1), 2: readConfig(lab, 2) };
  assert.ok(!report.previousConfig[1].test_force_unlock_refusal && !report.previousConfig[2].test_force_validation_failure, "refuse an already armed hook");
  try {
    configure(lab, 2, "{debug_mode=true,test_force_validation_failure=true}");
    configure(lab, 1, "{debug_mode=true,test_force_unlock_refusal=1000}");
    report.armed = { 1: readConfig(lab, 1), 2: readConfig(lab, 2) }; save();
    report.transferId = start(lab, report.name); save();
    report.outcome = await terminal(lab, report.transferId, "failed");
    assert.equal(report.outcome.status, "failed", "the forced validation failure must record a failed transfer");
    report.afterFailure = observe(lab, report, report.transferId); save();
    const failed = report.afterFailure;
    assert.equal(failed.pending.length, 1, "the pending intent must survive a refused unlock");
    assert.equal(failed.pending[0].transferId, report.transferId);
    assert.equal(failed.pending[0].rollbackPending, true, "the intent must record that only the rollback is pending");
    assert.equal(failed.sourceLocks, 1, "the refused unlock must keep the source lock");
    assert.equal(failed.source.present, true); assert.equal(failed.source.locked, true); assert.equal(failed.source.usable, false);
    assert.equal(failed.destination.present, false, "the rejected destination copy must be discarded");
    assert.deepEqual(failed.source.cargo, expectedCargo, "the locked source keeps its physical cargo");
    assert.ok(failed.events.includes("validation_failed") && failed.events.includes("rollback_failed"), `failure evidence missing: ${failed.events}`);
    assert.equal(failed.history.sourceRollback, "failed");
    report.retried = await lab.until(() => {
      const events = eventTypes(readLogEntry(lab, report.transferId));
      return events.filter(type => type === "rollback_failed").length >= 2 ? events : false;
    }, "recovery retried the refused unlock", 120); save();
    let refusal = null;
    try { lab.ctl("surface-export", "release-rollback", report.transferId); }
    catch (error) { refusal = error.message; }
    report.releaseRefused = { message: refusal, pending: readPending(lab).length, sourceLocks: sourceLocks(lab) }; save();
    assert.ok(refusal, "release-rollback must be refused while the source still holds the lock");
    assert.match(refusal, /still holds this transfer's lock/, refusal);
    assert.equal(report.releaseRefused.pending, 1); assert.equal(report.releaseRefused.sourceLocks, 1);
    report.interruption = { kind: "controller SIGKILL while the rollback is pending" }; save();
    lab.mutateContainer("kill", lab.controller, ["--signal", "KILL"]);
    lab.mutateContainer("start", lab.controller);
    await lab.ready();
    report.afterRestart = await lab.until(() => (summary(lab, report.transferId) ? observe(lab, report, report.transferId) : false),
      "history after the controller restart", 120); save();
    assert.equal(report.afterRestart.history.status, "failed", "a restart must not relabel the pending rollback as cleanup_failed");
    assert.equal(report.afterRestart.pending.length, 1, "the intent must survive the restart");
    assert.equal(report.afterRestart.sourceLocks, 1);
    assert.equal(report.afterRestart.destination.present, false);
    configure(lab, 1, "{test_force_unlock_refusal=false}");
    report.disarmedAt = new Date().toISOString(); save();
    report.resolved = await lab.until(() => {
      const state = observe(lab, report, report.transferId);
      return state.pending.length === 0 && state.history?.sourceRollback === "succeeded" ? state : false;
    }, "the retried unlock released the source and the intent", 300); save();
    const done = report.resolved;
    assert.equal(done.history.status, "failed", "the transfer stays failed after its source is released");
    assert.ok(!done.history.timingPendingRecovery, "no recovery stays pending after the release");
    assert.equal(done.sourceLocks, 0, "the source lock must be released");
    assert.equal(done.source.present, true); assert.equal(done.source.usable, true); assert.equal(done.destination.present, false);
    assert.deepEqual(done.source.cargo, expectedCargo, "the released source keeps exact cargo");
    assert.ok(done.events.includes("rollback_success"), `rollback_success missing: ${done.events}`);
    assert.ok(done.events.includes("validation_failed"), "the original failure evidence must survive the restart and the resolution");
    assert.ok(!done.events.includes("cleanup_failed"), "no misrouted destination verify may have run");
    assert.equal(done.entryStatus, "failed");
    assert.doesNotMatch(String(done.entryError), /Destination hold not confirmed/);
    const prior = transferIds(lab);
    report.retryRequest = lab.ctl("surface-export", "start-transfer", String(lab.ids[1]), String(platformIndex(lab, report.name)), String(lab.ids[2])).trim();
    save();
    report.retryOutcome = await lab.until(() => {
      const row = JSON.parse(lab.ctl("surface-export", "list-transfers", "200").trim().split(/\r?\n/).at(-1))
        .find(candidate => candidate.platformName === report.name && !prior.has(candidate.transferId)
          && ["completed", "failed", "error", "cleanup_failed"].includes(candidate.status));
      return row || false;
    }, "queue-admitted retry reached a terminal verdict", 180);
    report.retryId = report.retryOutcome.transferId;
    report.final = sample(lab, report.name); save();
    assert.notEqual(report.retryId, report.transferId);
    assert.equal(report.retryOutcome.status, "completed", "a fresh queue-admitted transfer must complete once the reservation is released");
    assert.equal(report.final.source.present, false); assert.equal(report.final.destination.usable, true);
    assert.deepEqual(report.final.destination.cargo, expectedCargo);
    assert.equal(readPending(lab).length, 0);
    report.notTested = ["The belt-cargo restore refusal of the staggered-capture branch; the lab refuses through the fail-safe hook",
      "release-rollback acceptance on a live cluster; its acceptance paths are covered by the plugin unit tests"];
  } finally {
    report.restoreErrors = [];
    for (const host of [1, 2]) {
      const previous = report.previousConfig?.[host];
      if (!previous) continue;
      try {
        configure(lab, host, `{debug_mode=${literal(previous.debug_mode)},test_force_validation_failure=${literal(previous.test_force_validation_failure)},`
          + `test_force_unlock_refusal=${literal(previous.test_force_unlock_refusal)}}`);
      } catch (error) { report.restoreErrors.push({ host, error: error.message }); }
    }
    save();
  }
}
