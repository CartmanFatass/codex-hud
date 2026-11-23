import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { HudStatus } from '../../dist/collectors/hud-status.js';
import { RolloutParser } from '../../dist/collectors/rollout.js';
import { stripAnsi } from '../../dist/render/colors.js';
import { fitStatusBar } from '../../dist/render/header.js';
import { BAR_FIELDS, BAR_STYLES, setDisplayConfig } from '../../dist/render/hud-config.js';
import { DEFAULT_LAYOUT } from '../../dist/types.js';

const time = (seconds) => new Date(Date.UTC(2026, 0, 2, 12, 0, seconds)).toISOString();
const jsonl = (...rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
function fixtureDir(t) {
  const home = mkdtempSync(join(tmpdir(), 'hud-tps-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test('Claude statusline estimates the latest linked response from its bounded transcript tail', (t) => {
  const home = fixtureDir(t),
    transcript = join(home, 'transcript.jsonl'),
    hud = join(home, 'hud');
  mkdirSync(hud);
  writeFileSync(join(hud, 'config.json'), JSON.stringify({ statusline: { gitStatus: { enabled: false } } }));
  const user = (timestamp, uuid) => ({ type: 'user', timestamp, uuid, message: { role: 'user', content: 'Synthetic' } });
  const response = (timestamp, uuid, parentUuid, id, output_tokens) => ({
    type: 'assistant',
    timestamp,
    uuid,
    parentUuid,
    message: { id, role: 'assistant', content: [{ type: 'text', text: 'Synthetic' }], usage: { output_tokens } },
  });
  const render = () => {
    const result = spawnSync(process.execPath, ['bin/hud-statusline', '--width', '120'], {
      input: JSON.stringify({
        transcript_path: transcript,
        cwd: '/synthetic/demo',
        model: { id: 'claude-opus-4-5' },
        effort: 'high',
        context_window: { used_percentage: 42, context_window_size: 200000 },
      }),
      env: { HOME: home, HUD_HOME: hud, HUD_STATUSLINE_PROC_ROOT: join(home, 'proc'),
        CLAUDE_CONFIG_DIR: join(home, 'claude'), NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 25000,
    });
    assert.equal(result.status, 0, result.stderr);
    return stripAnsi(result.stdout).trimEnd();
  };
  // The orphan in the tail cannot borrow the timestamp from the bounded head probe.
  const padding = jsonl({ type: 'padding', ignored: 'x'.repeat(220_000) }).repeat(5);
  writeFileSync(transcript, jsonl(user(time(0), 'old')) + padding + jsonl(response(time(4), 'a', 'old', 'msg-old', 200)));
  assert.doesNotMatch(render(), /t\/s/);
  appendFileSync(
    transcript,
    jsonl(user(time(5), 'u'), response(time(9), 'b', 'u', 'msg-new', 123), response(time(15), 'c', 'b', 'msg-new', 123))
  );
  const line = render();
  assert.match(line, /~12\.3 t\/s/);
  assert.equal(render(), line, 'unchanged transcript retains the latest sample');
  t.diagnostic(line);
  appendFileSync(transcript, jsonl(response(time(20), 'd', 'unknown-parent', 'msg-unknown', 80)));
  assert.doesNotMatch(render(), /t\/s/);
});

test('Codex rollout estimate reaches the fitted bar in every style and drops early when narrow', async (t) => {
  const cwd = join(fixtureDir(t), 'demo');
  mkdirSync(cwd);
  const file = join(cwd, 'rollout.jsonl');
  const event = (second, type, fields = {}) => ({
    type: 'event_msg', timestamp: time(second), payload: { type, ...fields },
  });
  const count = (second, output_tokens) =>
    event(second, 'token_count', { info: { total_token_usage: { output_tokens } } });
  writeFileSync(
    file,
    jsonl(
      { type: 'session_meta', timestamp: time(0), payload: { id: 'synthetic', cwd, timestamp: time(0) } },
      count(1, 200),
      event(2, 'turn_started'),
      { type: 'turn_context', timestamp: time(2), payload: { model: 'gpt-5' } }
    )
  );
  const parser = new RolloutParser();
  parser.setRolloutPath(file);
  const status = new HudStatus(cwd);
  const build = async () => status.build({ rollout: await parser.parse(), stale: false, skipGit: true });
  const paint = (data, width = 100) => fitStatusBar(data, DEFAULT_LAYOUT, width, Date.parse(time(6)));
  const previous = setDisplayConfig({ theme: 'terminal', barStyle: 'line', barFields: [...BAR_FIELDS] });
  t.after(() => setDisplayConfig(previous));
  assert.doesNotMatch(stripAnsi(paint(await build()).line), /t\/s/);
  appendFileSync(file, jsonl(count(6, 370)));
  const data = await build();
  t.diagnostic(stripAnsi(paint(data).line).trimEnd());
  for (const barStyle of BAR_STYLES) {
    setDisplayConfig({ barStyle });
    assert.match(stripAnsi(paint(data).line), /~42\.5 t\/s/, barStyle);
    const narrow = paint(data, 15);
    assert.ok(narrow.kept.includes('model'), barStyle);
    assert.ok(!narrow.kept.includes('tps'), barStyle);
  }
  setDisplayConfig({ barFields: ['model', 'project'] });
  assert.doesNotMatch(stripAnsi(paint(data).line), /t\/s/);
});
