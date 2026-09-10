import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { withWorkflowLock } from '../../../tools/shared/workflow-lock.mjs';
import { readTransactionLogStore } from '../../../tools/tests/testkit/log-query.mjs';
import {
  lua, rcon, sleep, preflightState, assertLeaseClean, fetchTransferSummaries, instanceIds,
} from '../../lab-gallery/batch-lifecycle.mjs';
import { capture } from './capture.mjs';

const mode = process.argv[2];
assert.ok(['--supervised-client', '--cleanup-proof', '--analyze'].includes(mode),
  'choose --supervised-client, --cleanup-proof, or --analyze <report.json>');

function summary(report) {
  const compact = value => value && {
    averageUps: value.averageUps, minRolling60TickUps: value.minRolling60TickUps,
    maxUpdateGapMs: value.maxUpdateGapMs, p99UpdateGapMs: value.p99UpdateGapMs,
    gapsOver50ms: value.gapsOver50ms, maxSchedulerCallbackMs: value.maxSchedulerCallbackMs,
  };
  return {
    name: report.name, verdict: report.verdict, error: report.error,
    transferId: report.outcome?.transferId, controllerObservedMs: report.outcome?.observedDurationMs,
    verification: report.verification, cleanup: report.cleanup,
    idle: { server: compact(report.idle?.server), client: compact(report.idle?.client) },
    transfer: { server: compact(report.transfer?.server), client: compact(report.transfer?.client) },
  };
}

if (mode === '--analyze') {
  console.log(JSON.stringify(summary(JSON.parse(readFileSync(process.argv[3], 'utf8'))), null, 2));
} else {
  await withWorkflowLock(run);
}

async function run() {
  const fixturePath = 'tests/integration/transfer-cleanup/probe.lua';
  const code = readFileSync(fixturePath, 'utf8');
  const name = `transfer-cleanup-tickwatch-${Date.now().toString(36)}`;
  const report = {
    name, mode, createdAt: new Date().toISOString(), sourceHost: 2, targetHost: 1,
    contract: {
      fixture: '806 entities, 400 full chests, 402 belts, 16384 tiles',
      invariant: 'Exact independently read cargo by inventory, quality and belt side; identical tiles; original worlds preserved',
      measurement: 'Host-1 server and Steam client local tick cadence. Rendered FPS unmeasured.',
      interval: 'Recorder arm before gateway command through observed terminal result and recorder finish; includes control/polling overhead. Construction, cargo oracle and cleanup excluded.',
      limits: 'One transfer; at most 90 summary polls and 90 seconds between polls; RCON helper timeout 180 seconds; recorder cap 7200 ticks.',
      stop: 'Any incomplete recording, disconnected client, failed transfer, cargo mismatch, or cleanup failure prevents baseline acceptance.',
      performance: 'One observation baseline, not a universal performance bound or an optimization claim.',
    },
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    hashes: {}, worlds: {}, cleanup: {}, verification: 'NOT TESTED', verdict: 'HARNESS_ERROR',
  };
  for (const file of [fixturePath, 'tests/instruments/tick-watch/probe.lua',
    'tests/instruments/tick-watch/capture.mjs', 'tests/instruments/tick-watch/analyze.mjs',
    'tests/instruments/tick-watch/full-transfer.mjs']) {
    report.hashes[file] = createHash('sha256').update(readFileSync(file)).digest('hex');
  }
  mkdirSync('ci-artifacts', { recursive: true });
  const save = () => writeFileSync(`ci-artifacts/${name}.json`, JSON.stringify(report, null, 2));
  const checked = value => { assert.equal(value.success, true, value.error); return value; };
  const probe = (host, action) => checked(lua(host,
    `local p=(function() ${code} end)();return p('${action}','${name}')`));
  const player = message => checked(lua(1,
    `local p=assert(game.get_player('solarcloud7'));assert(p.connected,'client disconnected');` +
    (message ? `p.print('${message}');` : '') +
    'return {success=true,physical=p.physical_surface.name,view=p.surface.name}'));
  const ready = (host, phase) => {
    const state = preflightState(host);
    assert.equal(state.players, host === 1 ? 1 : 0, 'requires one consenting client on host-1');
    // The supervised fixture permits this player; every other lease check remains enforced.
    assertLeaseClean(host, { ...state, players: 0 }, phase);
    return state;
  };
  let built = false, injected = false, cleanupFailed = false;
  try {
    for (const host of [1, 2]) {
      ready(host, 'supervised preflight'); report.worlds[host] = probe(host, 'world');
      assert.equal(report.worlds[host].engine, '2.1.17');
    }
    report.playerBefore = player('Automatic transfer measurement preparing. You can stay on your current surface.');
    // Existing platforms are safe observer locations. World preflight already refused
    // foreign lab fixtures, and no player is put aboard the newly constructed one.
    if (mode !== '--cleanup-proof') {
      report.idle = await capture(async () => { await sleep(5000); return { phase: 'idle' }; });
      assert.ok(report.idle.client && !report.idle.clientUnavailable, 'idle client evidence unavailable');
    }
    const ids = instanceIds();
    built = true; // Cleanup also runs after a partially failed construction call.
    report.build = probe(2, 'build-large'); report.tilesBefore = probe(2, 'tiles'); save();
    if (mode !== '--cleanup-proof') {
      checked(lua(2, `local p=assert(game.forces.player.platforms[${report.build.state.index}]);` +
        `assert(p.name=='${name}');local s=p.get_schedule();` +
        "s.add_record{station='surfexp_gateway_hub',index={schedule_index=1}};" +
        "p.space_location='surfexp_gateway_hub';p.paused=false;return {success=true}"));
      player('Automatic transfer measurement starting. No need to watch the overlay.');
    }
    report.transfer = await capture(async () => {
      if (mode === '--cleanup-proof') {
        await sleep(1500); injected = true; throw new Error('intentional full-transfer runner failure');
      }
      report.triggerAt = new Date().toISOString();
      report.trigger = rcon(2, `/gateway-transfer ${report.build.state.index} ${ids[1]}`);
      const deadline = Date.now() + 90000;
      for (let attempt = 0; attempt < 90 && Date.now() < deadline; attempt++) {
        const rows = fetchTransferSummaries({ limit: 20 });
        assert.ok(rows, 'transfer summary query unavailable');
        const row = rows.find(value => value.platformName === name);
        if (row && ['completed', 'failed', 'cleanup_failed'].includes(row.status)) {
          report.outcome = row; break;
        }
        await sleep(1000);
      }
      assert.ok(report.outcome, 'transfer polling deadline exceeded');
      report.observedTerminalAt = new Date().toISOString();
      return { transferId: report.outcome.transferId, status: report.outcome.status };
    });
    assert.ok(report.transfer.client && !report.transfer.clientUnavailable, 'transfer client evidence unavailable');
    report.playerAfter = player('Automatic transfer measurement complete. Checking cargo and removing the test fixture.');
    assert.equal(report.playerAfter.physical, report.playerBefore.physical, 'player physical surface changed');
    assert.equal(report.outcome.status, 'completed');
    report.after = probe(1, 'read'); report.tilesAfter = probe(1, 'tiles');
    assert.deepEqual(report.after.state.cargo, report.build.state.cargo);
    assert.deepEqual(report.tilesAfter.tiles, report.tilesBefore.tiles);
    assert.equal(probe(2, 'exists').present, false, 'source copy remains');
    report.verification = { cargo: 'PASS', tiles: 'PASS', sourceAbsent: true };
    report.detail = readTransactionLogStore().find(value => value.transferId === report.outcome.transferId);
    assert.ok(report.detail, 'retained transaction detail missing');
    report.verdict = 'PASS';
  } catch (error) {
    report.error = error.stack;
    report.expectedFailure = injected && error.message === 'intentional full-transfer runner failure';
  } finally {
    if (built) for (const host of [1, 2]) {
      try {
        // Never erase an in-flight or held transfer as part of fixture cleanup.
        const state = preflightState(host);
        for (const key of ['jobs', 'locks', 'holds']) assert.equal(state[key], 0, `cleanup refused: ${key}`);
        checked(lua(host, `for _,p in pairs(game.players) do for _,v in pairs(game.forces.player.platforms) do ` +
          `if v.name=='${name}' and p.surface.index==v.surface.index then ` +
          "assert(p.physical_surface.name=='nauvis','physical player aboard');" +
          "p.set_controller{type=defines.controllers.remote,surface='nauvis',position=p.physical_position} " +
          'end end end;return {success=true}'));
        probe(host, 'cleanup'); await sleep(600);
        assert.equal(probe(host, 'exists').present, false);
        const postflight = ready(host, 'supervised postflight');
        assert.deepEqual(probe(host, 'world').world, report.worlds[host].world);
        report.cleanup[host] = { absent: true, worldPreserved: true, state: postflight };
      } catch (error) { cleanupFailed = true; report.cleanup[host] = { error: error.message }; }
    }
    if (cleanupFailed) report.verdict = 'HARNESS_ERROR';
    report.cleanupProofPassed = Boolean(report.expectedFailure && built && !cleanupFailed);
    save(); console.log(JSON.stringify(summary(report), null, 2));
    console.log(`Artifact: ci-artifacts/${name}.json`);
  }
  if (report.verdict !== 'PASS' && !report.cleanupProofPassed) process.exitCode = 1;
  if (report.cleanupProofPassed) console.log('PASS: intentional runner failure and fixture/recorder cleanup verified. Workload NOT TESTED.');
}
