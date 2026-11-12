import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defaultSettings, loadSettings } from '../../src/settings.js';
import { SETTING_ROWS, renderSettingsPage } from '../../src/render/settings-page.js';
import { ModelJobs, NO_JOBS } from '../../src/collectors/model-jobs.js';
import { SmallModel } from '../../src/collectors/small-model.js';
import { AgentLog } from '../../src/collectors/agent-log.js';
import { ProgressSummarizer } from '../../src/collectors/progress-summary.js';
import { initialMonitorState, monitorSettings, renderMonitor } from '../../src/render/monitor.js';
import { stripAnsi } from '../../src/render/colors.js';
import type { SubagentTree } from '../../src/types.js';
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('LLM has only switch, model and cap; key defaults on and old feature settings are ignored', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-thin-'));
  const saved = { ...process.env };
  try {
    process.env.HUD_HOME = home;
    delete process.env.HUD_SETTINGS_PATH;
    delete process.env.MISTRAL_API_KEY;
    delete process.env.OPENAI_API_KEY;
    assert.equal(defaultSettings().modelEnabled, false);
    fs.writeFileSync(path.join(home, 'credentials.env'), 'MISTRAL_API_KEY=synthetic-key\n', { mode: 0o600 });
    fs.writeFileSync(
      path.join(home, 'hud-settings.json'),
      JSON.stringify({ briefing: 'off', briefAgents: false, changeSummary: true })
    );
    const draft = loadSettings();
    assert.equal(draft.modelEnabled, true);
    assert.equal(draft.model, 'deepseek-v4-1-flash-1017');
    assert.equal('briefing' in draft, false);
    assert.equal('changeSummary' in draft, false);
    assert.deepEqual(
      SETTING_ROWS.filter((r) => r.group === 'LLM').map((r) => r.key),
      ['modelEnabled', 'model', 'modelCallsPerHour']
    );
    const text = stripAnsi(
      renderSettingsPage(
        { draft, selected: SETTING_ROWS.findIndex((r) => r.group === 'LLM'), offset: 0, message: '' },
        100,
        30
      ).lines.join('\n')
    );
    assert.match(text, /Model text/);
    assert.match(text, /Call cap/);
    assert.doesNotMatch(text, /consent|Backend|AGY/);
    fs.unlinkSync(path.join(home, 'credentials.env'));
    assert.equal(loadSettings().modelEnabled, false);
  } finally {
    process.env = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

for (const mode of ['on', 'off', 'no-key'] as const)
  test(`native card model text: ${mode}, no consent state`, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'native-text-'));
    const now = Date.parse('2026-11-01T10:00:00Z');
    let calls = 0;
    const model = new SmallModel({
      env: { HUD_HOME: home, MISTRAL_API_KEY: mode === 'no-key' ? '' : 'synthetic-key' },
      fetch: async (_url, init) => {
        calls++;
        const body = String(init?.body);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: body.includes('You name subagents')
                    ? '{"labels":[{"kind":"implementer","name":"Parser repair"}]}'
                    : body.includes('<answer>')
                      ? '{"conclusion":"Parser fixed"}'
                      : body.includes('<output>')
                        ? 'Missing parser input.'
                        : 'Checking parser boundaries.',
                },
              },
            ],
          })
        );
      },
    });
    model.configure({ backend: mode === 'off' ? 'off' : 'api' });
    const tree: SubagentTree = {
      rootId: 'root',
      totalCount: 1,
      updatedAt: new Date(now),
      nodes: [
        {
          id: 'agent',
          name: 'Original worker',
          task: 'Repair parser',
          depth: 1,
          children: [],
          status: 'running',
          startedAt: new Date(now),
          lastReport: { text: 'Reading parser', kind: 'update', at: new Date(now) },
        },
      ],
    };
    const log = new AgentLog(home);
    log.observe(tree);
    const jobs = new ModelJobs({
      model,
      log,
      read: async () =>
        JSON.stringify({ type: 'event_msg', payload: { type: 'error', message: 'Missing parser input' } }),
    });
    const progress = new ProgressSummarizer(model, log);
    const switches = mode === 'off' ? NO_JOBS : { resultDigest: true, agentLabels: true, failureCause: true };
    try {
      jobs.update({
        tree,
        main: null,
        switches,
        language: 'en',
        on: mode !== 'off',
        digestLabels: { basis: 'Basis:', caveats: 'Caveats:' },
        now,
      });
      progress.update({ tree, targets: new Set(['agent']), on: mode !== 'off', language: 'en', now });
      for (let i = 0; i < 12; i++) await tick();
      jobs.apply(tree, switches, 'en');
      const text = stripAnsi(
        renderMonitor({
          tree,
          state: { ...initialMonitorState(), ...monitorSettings(defaultSettings()) },
          agentLog: log.snapshot(),
          width: 56,
          height: 35,
          nowMs: now,
        }).lines.join('\n')
      );
      if (mode === 'on') {
        assert.equal(calls, 2);
        assert.match(text, /Parser repair/);
        assert.match(text, /Checking parser boundaries/);
      } else {
        assert.equal(calls, 0);
        assert.match(text, /Original worker/);
        assert.doesNotMatch(text, /Checking parser boundaries/);
      }
      assert.doesNotMatch(text, /consent|recipient|grant/i);
      if (mode === 'on') {
        const n = tree.nodes[0];
        n.status = 'completed';
        n.stages = [{ status: 'done', startedAt: new Date(now), endedAt: new Date(now + 1), result: 'Parser fixed' }];
        jobs.update({
          tree,
          main: null,
          switches,
          language: 'en',
          on: true,
          digestLabels: { basis: 'Basis:', caveats: 'Caveats:' },
          now: now + 2,
        });
        for (let i = 0; i < 12; i++) await tick();
        jobs.apply(tree, switches, 'en');
        assert.equal(n.digest, 'Parser fixed');
        n.status = 'error';
        n.statusAt = new Date(now + 3);
        n.rolloutPath = '/synthetic/agent.jsonl';
        jobs.update({
          tree,
          main: null,
          switches,
          language: 'en',
          on: true,
          digestLabels: { basis: 'Basis:', caveats: 'Caveats:' },
          now: now + 4,
        });
        for (let i = 0; i < 12; i++) await tick();
        assert.equal(log.latest('agent', new Set(['cause']), 'en')?.text, 'Missing parser input.');
      }
    } finally {
      jobs.stop();
      progress.stop();
      model.cancelAll();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
