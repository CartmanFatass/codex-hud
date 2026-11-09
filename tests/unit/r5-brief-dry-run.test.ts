import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { r5Fixture } from '../fixtures/r5-jobs.js';
import { makeSourceId } from '../../src/core/identity.js';
import { dryRunText } from '../../src/collectors/brief-dry-run.js';
import { defaultSettings } from '../../src/settings.js';
import { SessionFinder } from '../../src/collectors/session-finder.js';
import { RolloutParser } from '../../src/collectors/rollout.js';
import { buildSubagentTree, resetSubagentLinkCache } from '../../src/collectors/subagent-tree.js';
import { PanelJobPipeline } from '../../src/tree-page.js';
import { briefMaterial, lastNoteAt } from '../../src/collectors/briefing.js';
import { summaryTree } from '../../src/collectors/model-jobs.js';
import { AgentLog, logsIn } from '../../src/collectors/agent-log.js';

function snapshot(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  const scan = (at: string) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const file = join(at, entry.name);
      if (entry.isDirectory()) scan(file);
      else result[file.slice(dir.length)] = fs.readFileSync(file).toString('base64');
    }
  };
  scan(dir);
  return result;
}

test('R5 dry-run equals panel-eligible material for same real files/settings/time; no writes, model or backend start, explicit omitted jobs', async (t) => {
  const f = r5Fixture(t),
    home = join(f.home, 'codex'),
    hud = join(home, 'hud'),
    cwd = join(f.home, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const now = Date.now(),
    date = new Date(now),
    stamp = date.toISOString().slice(0, 10);
  const day = join(
    home,
    'sessions',
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  );
  fs.mkdirSync(day, { recursive: true });
  const rootId = '00000000-0000-0000-0000-00000000aaaa',
    childId = '00000000-0000-0000-0000-00000000bbbb';
  const line = (type: string, payload: object) =>
    JSON.stringify({ type, timestamp: new Date(now - 1000).toISOString(), payload }) + '\n';
  f.put(
    join(day, `rollout-${stamp}T00-00-00-${rootId}.jsonl`),
    line('session_meta', { id: rootId, cwd, timestamp: new Date(now - 1000).toISOString() })
  );
  f.put(
    join(day, `rollout-${stamp}T00-00-01-${childId}.jsonl`),
    line('session_meta', {
      id: childId,
      cwd,
      parent_thread_id: rootId,
      source: {
        subagent: { thread_spawn: { parent_thread_id: rootId, agent_path: '/root/native', agent_role: 'scout' } },
      },
    }) +
      line('event_msg', { type: 'task_started', turn_id: 'turn-1' }) +
      line('response_item', {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text: 'Reading the synthetic parser.' }],
      })
  );
  const env = { HOME: f.home, CODEX_HOME: home, CODEX_SESSIONS_PATH: join(home, 'sessions'), HUD_HOME: f.home };
  const prior = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of prior)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    resetSubagentLinkCache();
  });
  resetSubagentLinkCache();
  const root = `${makeSourceId('codex', fs.realpathSync(home))}/${rootId}`;
  const sentinel = 'R5_DRY_RUN_OMITTED_SENTINEL';
  f.receipt(f.association(1, { root, task_label: sentinel }));
  const settings = {
    ...defaultSettings(),
    briefing: 'api' as const,
    language: 'en' as const,
    resultDigest: false,
    agentLabels: false,
    importantRoles: '',
  };
  const session = new SessionFinder(cwd).check()!;
  assert.ok(session);
  const parser = new RolloutParser(40);
  parser.setRolloutPath(session.path);
  const main = await parser.parse();
  const nativeTree = buildSubagentTree(rootId, main?.subagents ?? []);
  const p = new PanelJobPipeline(f.home, root, { live: false, now: () => now });
  t.after(() => p.dispose());
  await p.refresh();
  const tree = summaryTree(p.compose(nativeTree, null, now, root).tree);
  const log = new AgentLog(join(hud, 'agent-log'));
  log.observe(tree);
  const logs = logsIn(log.snapshot(), 'en');
  const eligible = briefMaterial(tree, {
    scope: 'agents',
    language: 'en',
    labels: false,
    main,
    recap: null,
    logs,
    roles: new Set(),
    since: lastNoteAt(tree, logs),
    now,
  })!;
  assert.ok(eligible);
  const before = snapshot(f.home);
  let starts = 0;
  t.mock.method(childProcess, 'spawn', () => {
    starts++;
    throw new Error('backend started by preview');
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    starts++;
    throw new Error('model started by preview');
  };
  t.after(() => {
    globalThis.fetch = oldFetch;
  });
  const result = await dryRunText({ cwd, settings, codexHome: home, hudHome: hud, jobHome: f.home, now });
  assert.ok('text' in result, 'error' in result ? result.error : '');
  const material = result.text.split('=== material ===\n')[1]!.trimEnd();
  const system = result.text.split('=== instructions ===\n')[1]!.split('\n\n=== material ===')[0]!;
  assert.equal(material, eligible.write().prompt);
  assert.equal(system, eligible.write().system);
  assert.match(result.text, /Job-only summaries omitted/);
  assert.ok(!result.text.includes(sentinel));
  assert.equal(starts, 0);
  assert.deepEqual(snapshot(f.home), before);
});
