import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('synthetic cross-harness workbench exercises real accepted, replayed, supervised and cancelled intents', () => {
  const r=spawnSync(process.execPath,[resolve('scripts/workbench/vertical.mjs'),'--json'],{
    cwd:resolve('.'),encoding:'utf8',timeout:45000,
    env:{...process.env,EXAMPLE_SECRET:'must-not-propagate',OPENAI_API_KEY:'must-not-propagate',ANTHROPIC_API_KEY:'must-not-propagate'}
  });
  assert.equal(r.status,0,r.stderr);
  const value=JSON.parse(r.stdout);
  assert.match(value.label,/SIMULATED Claude.*SIMULATED Codex/);
  assert.equal(value.first.runId,value.first.replayRunId);
  assert.equal(value.dispatchCount,2);
  for (const scenario of [value.first,value.second]) {
    assert.equal(scenario.active.run.state,'running');
    assert.equal(scenario.active.slotHeld,true);
    assert.equal(scenario.active.events.filter((e)=>e==='launch.submitting').length,1);
  }
  assert.equal(value.first.ended.run.state,'ended');
  assert.equal(value.first.ended.slotHeld,false);
  assert.equal(value.first.ended.run.exit_code,null);
  assert.equal(value.second.cancel.accepted,true);
  assert.ok(value.second.cancelled.events.includes('cancel.accepted'));
  assert.ok(['ended','cancelled','failed'].includes(value.second.cancelled.run.state));
  assert.equal(value.second.cancelled.slotHeld,false);
  assert.deepEqual(value.childEnvironment,['CODEX_HOME','HOME','HUD_HOME','HUD_LAB_HELPER','PATH']);
  assert.ok(value.frames.every((f)=>f.panel.some((line)=>line.includes('SIMULATED Codex'))));
  assert.deepEqual(value.first.reports,[{status:'completed',summary:'SIMULATED child report'}]);
  assert.equal(value.first.reportedState.run.state,'running');
  assert.equal(value.first.reportedState.slotHeld,true);
  assert.ok(value.first.reportedState.events.includes('child.bound'));
  assert.ok(value.first.reportedState.events.includes('report.received'));
  const bound=value.frames.find((f)=>f.label==='bound / reported').relations.find((r)=>r.runId===value.first.runId);
  assert.equal(bound.attribution,'confirmed'); assert.equal(bound.childBound,true);
  assert.ok(value.frames.find((f)=>f.label==='bound / reported').panel.some((line)=>line.includes('reported')));
  assert.ok(value.frames.find((f)=>f.label==='scope ended').panel.some((line)=>line.includes('SIMULATED child report')));
  const second=value.frames.find((f)=>f.label==='second run active').relations.find((r)=>r.runId===value.second.runId);
  assert.equal(second.attribution,'intent'); assert.equal(second.childBound,false);
  assert.equal(value.frames[0].relations.find((r)=>r.runId===value.first.runId).state,'running');
  assert.equal(value.frames.find((f)=>f.label==='scope ended').relations.find((r)=>r.runId===value.first.runId).state,'ended');
  assert.ok(value.supervisorExits.every((exit)=>exit.code===0));
});

test('direct runner never removes an environment-supplied home', async () => {
  const {mkdtempSync,writeFileSync,readFileSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const supplied=mkdtempSync(join(tmpdir(),'hud-workbench-caller-'));
  const marker=join(supplied,'keep.txt'); writeFileSync(marker,'preserve');
  try {
    const r=spawnSync(process.execPath,[resolve('scripts/workbench/vertical-runner.mjs'),'--json'],{
      cwd:resolve('.'),encoding:'utf8',timeout:45000,
      env:{HOME:supplied,HUD_HOME:supplied,CODEX_HOME:supplied,TMPDIR:supplied,PATH:'/usr/bin:/bin',LANG:'C'}
    });
    assert.equal(r.status,0,r.stderr);
    assert.equal(readFileSync(marker,'utf8'),'preserve');
  } finally { rmSync(supplied,{recursive:true,force:true}); }
});

test('lab reporter rejects a caller outside its owned synthetic child', async () => {
  const {mkdtempSync,writeFileSync,existsSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const home=mkdtempSync(join(tmpdir(),'hud-reporter-refusal-'));
  try {
    writeFileSync(join(home,'synthetic-codex'),'not an executable');
    const r=spawnSync(process.execPath,[resolve('scripts/workbench/synthetic-handshake.mjs')],{
      cwd:home,encoding:'utf8',timeout:10000,
      env:{HOME:home,HUD_HOME:home,CODEX_HOME:home,PATH:'/usr/bin:/bin',HUD_RUN:'synthetic',HUD_CLAIM:'synthetic-refusal-claim'}
    });
    assert.notEqual(r.status,0); assert.equal(existsSync(join(home,'ledger.sqlite')),false);
    assert.doesNotMatch(r.stdout+r.stderr,/synthetic-refusal-claim/);
  } finally { rmSync(home,{recursive:true,force:true}); }
});
