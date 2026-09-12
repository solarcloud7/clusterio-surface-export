const exitCodes = { PASS: 0, STOP: 2, FAIL: 1, HARNESS_ERROR: 1 };

/** Own cancellation and cleanup, leaving fixture setup and physical oracles in each runner. */
export async function runLab({ lab, report, save, work, analyze, beforeCleanup,
  cleanup = () => lab.cleanup(), expectedFailure }) {
  let workError;
  const errors = [];
  const failed = error => {
    errors.push(error.stack || String(error));
    report.error ??= errors.at(-1);
    return report.error;
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
      workError = error; failed(error);
      report.verdict = error.code === 'ACCEPTANCE_STOP' ? 'STOP' : 'HARNESS_ERROR';
    }
    // An auxiliary resource failing to close must not skip owned Docker cleanup.
    try { await beforeCleanup?.(); } catch (error) { report.error = failed(error); }
    try { report.cleanup = await cleanup(); }
    catch (error) { failed(error); report.cleanup ??= { success: false, errors: [String(error)] }; }
    try { if (analyze) Object.assign(report, await analyze(report)); }
    catch (error) { report.error = failed(error); report.verdict = 'HARNESS_ERROR'; }
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
