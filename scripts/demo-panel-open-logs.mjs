/** E1 component-composition simulation. No provider, host mutation, settings or real session. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunArtifacts } from '../dist/core/run/artifacts.js';
import { DelegationLogView } from '../dist/utils/delegation-log-view.js';
import { dispatchDelegationAction } from '../dist/utils/delegation-actions.js';
import { withPanelHostAvailability } from '../dist/integrations/herdr/panel-host.js';
import { buildVm, S, ago } from '../dist-test/tests/fixtures/b10b-delegation.js';
import { draw, press } from '../dist-test/tests/fixtures/b10b-s3.js';

const home = mkdtempSync(join(tmpdir(), 'hud-e1-demo-'));
try {
  const built = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.working(ago(10)) },
    {
      id: 'worker',
      parent: 'main',
      harness: 'codex',
      label: 'synthetic worker',
      status: S.working(ago(5)),
      run: { state: 'running', mode: 'headless' },
    },
  ]);
  const key = built.keys.worker;
  const run = built.vm.tree.nodes.find((n) => n.key === key).currentRun;
  run.expectedGeneration = 1;
  run.sourceId = 'ab'.repeat(32);
  run.harness = 'codex';
  const artifacts = RunArtifacts.create(home, run.runId);
  artifacts.writeMeta({
    schema_version: 1,
    run_id: run.runId,
    link_id: run.linkId,
    source_id: run.sourceId,
    binding_generation: 1,
    mode: 'headless',
    supervision_strategy: 'headless',
    supervisor: null,
    command_leader: null,
    harness: null,
    scope: null,
    launch_digest: 'a'.repeat(64),
    profile_digest: 'b'.repeat(64),
    launch_call_id: 'synthetic-call',
    launch_correlation_id: 'synthetic-correlation',
    created_at: 1000,
    stdin_mode: 'closed',
    capture: 'file',
    launch_cwd: '/synthetic/project',
    project_origin: null,
  });
  const logs = artifacts.openLogs();
  writeSync(logs.stdout, 'Synthetic build: 3 checks passed.\nUnsafe terminal bytes are displayed as text: \x1b[2J\n');
  writeSync(logs.stderr, 'Synthetic stderr: one dependency warning.\n');
  closeSync(logs.stdout);
  closeSync(logs.stderr);
  const context = { vm: built.vm, root: 'main', epoch: 1, selected: key };
  const viewer = new DelegationLogView();
  const frame = draw(built.vm, { selected: key, width: 80, height: 24 });
  const action = press(frame, 'log').action;
  assert.equal(action.type, 'delegation-log');
  const message = await dispatchDelegationAction(action, frame.delegation.vm, built.vm, true, {
    home,
    copy: async () => false,
    openLog: () => viewer.open(home, key, context),
  });
  assert.equal(message, 'Log viewer opened.');
  console.log('E1 SIMULATION: real monitor action, dispatcher, private artifact and in-panel viewer.');
  console.log('No real host or provider capability is being claimed.\n');
  const stdout = viewer.render(80, 12);
  assert.doesNotMatch(stdout.lines.join('\n'), /\x1b/);
  console.log(stdout.lines.join('\n'));
  viewer.input({ type: 'key', key: 'tab' }, stdout, context);
  console.log('\n' + viewer.render(80, 8).lines.join('\n'));
  viewer.input({ type: 'key', key: 'escape' }, undefined, context);
  assert.equal(viewer.isOpen, false);
  run.mode = 'visible';
  const unavailable = draw(withPanelHostAvailability(built.vm, null), { selected: key, width: 80, height: 24 });
  assert.equal(press(unavailable, 'open-session').action, undefined);
  console.log('\nPASS: stdout/stderr, escaped controls, Close and unverified Open refusal.');
} finally {
  rmSync(home, { recursive: true, force: true });
}
