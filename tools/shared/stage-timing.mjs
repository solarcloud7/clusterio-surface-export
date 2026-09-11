import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { redactDiagnostic } from "./diagnostics.mjs";

export const contract = { requires: ["one process clock", "report persistence"],
  produces: ["local elapsed stage intervals", "incomplete stage evidence"],
  "does not": ["measure exclusive CPU time", "infer missing end times"] };

export function stageTimer(records, save, { clock = () => performance.now(), utc = () => new Date().toISOString() } = {}) {
  const origin = clock();
  return async (name, work, { alwaysRun = false } = {}) => {
    assert.ok(!records.some(record => record.name === name), `Duplicate stage ${name}`);
    const start = clock();
    const record = { name, status: "running", startedAt: utc(), startMs: start - origin };
    const persist = () => {
      try { save(); }
      catch (error) { (record.evidenceErrors ??= []).push(redactDiagnostic(error.message)); return error; }
    };
    records.push(record);
    const initialError = persist();
    if (initialError && !alwaysRun) throw initialError;
    let result, failure;
    try {
      result = await work();
      record.status = "passed";
    } catch (error) {
      record.status = "failed";
      record.error = redactDiagnostic(error.message);
      failure = error;
    }
    const end = clock();
    record.endMs = end - origin; record.elapsedMs = end - start; record.finishedAt = utc();
    const finalError = persist();
    if (failure || initialError || finalError) throw failure || initialError || finalError;
    return result;
  };
}
