const exitCodes = { PASS: 0, STOP: 2, FAIL: 1, HARNESS_ERROR: 1 };

export async function runLab({ lab, report, save, work, analyze, beforeCleanup,
  cleanup = () => lab.cleanup(), expectedFailure }) {
  let workError;
  const errors = [];
  const failureMessage = error => {
    errors.push(error.stack || String(error));
    return report.error ?? errors[0];
  };
  const interrupt = signal => {
    lab.cancelled = true;
    report.interrupted ??= signal;
  };
  const sigint = () => interrupt('SIGINT'), sigterm = () => interrupt('SIGTERM');
  process.on('SIGINT', sigint); process.on('SIGTERM', sigterm);
  try {
    try { save(); await work(); }
    catch (error) {
      workError = error; report.error = failureMessage(error);
      report.verdict = error.code === 'ACCEPTANCE_STOP' ? 'STOP' : 'HARNESS_ERROR';
    }
    try { await beforeCleanup?.(); } catch (error) { report.error = failureMessage(error); }
    try { report.cleanup = await cleanup(); }
    catch (error) { report.error = failureMessage(error); report.cleanup ??= { success: false, errors: [String(error)] }; }
    try { if (analyze) Object.assign(report, await analyze(report)); }
    catch (error) { report.error = failureMessage(error); report.verdict = 'HARNESS_ERROR'; }
    if (workError && report.verdict === 'PASS') report.verdict = 'HARNESS_ERROR';
    if (expectedFailure) report.cleanupProofPassed = errors.length === 1 && !!workError
      && expectedFailure.test(workError.message) && report.cleanup?.success === true && !report.interrupted;
    if (!report.cleanup?.success || report.interrupted || errors.length > (workError ? 1 : 0)) {
      report.verdict = 'HARNESS_ERROR';
    }
    if (errors.length) report.harnessErrors = errors;
    if (!(report.verdict in exitCodes)) report.verdict = 'HARNESS_ERROR';
    report.finishedAt = new Date().toISOString();
    save();
    return report.cleanupProofPassed ? 0 : exitCodes[report.verdict];
  } finally {
    process.removeListener('SIGINT', sigint); process.removeListener('SIGTERM', sigterm);
  }
}
