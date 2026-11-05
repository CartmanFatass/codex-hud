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
  assert.deepEqual(value.childEnvironment,['CODEX_HOME','HOME','HUD_HOME','PATH']);
  assert.ok(value.frames.every((f)=>f.panel.some((line)=>line.includes('SIMULATED Codex'))));
  assert.ok(value.frames.flatMap((f)=>f.relations).every((r)=>r.attribution==='intent' && !r.childBound));
  assert.equal(value.frames[0].relations.find((r)=>r.runId===value.first.runId).state,'running');
  assert.equal(value.frames[1].relations.find((r)=>r.runId===value.first.runId).state,'ended');
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
