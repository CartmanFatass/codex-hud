import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { t, setLanguage, resolveLanguage } from '../../src/render/i18n.js';
import { initialMonitorState, renderMonitor } from '../../src/render/monitor.js';
import { renderSettingsPage, SETTING_ROWS } from '../../src/render/settings-page.js';
import { Briefer, briefingCommand, briefSystemPrompt } from '../../src/collectors/briefing.js';
import { defaultSettings, loadSettings, saveSettings } from '../../src/settings.js';
import { stripAnsi, visualLength } from '../../src/render/colors.js';
import type { SubagentTree, SubagentTreeNode } from '../../src/types.js';

const now = Date.parse('2026-10-01T10:00:00Z');
const root = '00000000-0000-4000-8000-000000000001';
const node = (id: string, name: string, status: SubagentTreeNode['status']): SubagentTreeNode =>
  ({ id, name, status, depth: 1, children: [], turnStartedAt: new Date(now - 30_000), lastEventAt: new Date(now - 1000) });
const tree: SubagentTree = { rootId: root, totalCount: 2, updatedAt: new Date(now),
  nodes: [node('00000000-0000-4000-8000-000000000002', 'Hegel', 'running'), node('00000000-0000-4000-8000-000000000003', 'Pasteur', 'completed')] };

function inChinese<T>(run: () => T): T {
  const previous = setLanguage('zh');
  try { return run(); } finally { setLanguage(previous); }
}

test('auto follows a zh locale, and an explicit choice wins over the locale', () => {
  assert.equal(resolveLanguage('auto', { LANG: 'zh_CN.UTF-8' }), 'zh');
  assert.equal(resolveLanguage('auto', { LANG: 'C.UTF-8' }), 'en');
  assert.equal(resolveLanguage('auto', { LC_ALL: 'zh_TW.UTF-8', LANG: 'en_US.UTF-8' }), 'zh');
  assert.equal(resolveLanguage('en', { LANG: 'zh_CN.UTF-8' }), 'en');
  assert.equal(resolveLanguage('zh', {}), 'zh');
});

test('t fills placeholders, and an untranslated string falls back to English', () => {
  assert.equal(t('+{n} older', { n: 3 }), '+3 older');
  inChinese(() => {
    assert.equal(t('+{n} older', { n: 3 }), '+3 已收起');
    assert.equal(t('Not in the table'), 'Not in the table');
    assert.equal(t('en'), 'English');
  });
  assert.equal(t('zh'), '中文');
});

test('the language setting defaults to auto and accepts only auto, en and zh', () => {
  assert.equal(defaultSettings().language, 'auto');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-lang-'));
  const file = path.join(dir, 'hud-settings.json');
  const previous = process.env.CODEX_HUD_SETTINGS_PATH;
  process.env.CODEX_HUD_SETTINGS_PATH = file;
  try {
    saveSettings({ language: 'zh' });
    assert.equal(loadSettings().language, 'zh');
    fs.writeFileSync(file, JSON.stringify({ language: 'fr' }));
    assert.equal(loadSettings().language, 'auto');
  } finally {
    if (previous === undefined) delete process.env.CODEX_HUD_SETTINGS_PATH;
    else process.env.CODEX_HUD_SETTINGS_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the panel speaks Chinese and keeps its width at every size', () => {
  for (const width of [16, 20, 30, 45]) {
    const frame = inChinese(() => renderMonitor({ tree, state: initialMonitorState(), width, height: 20, nowMs: now }));
    for (const line of frame.lines) assert.ok(visualLength(line) <= width, `${width}: ${stripAnsi(line)}`);
    const text = stripAnsi(frame.lines.join('\n'));
    assert.match(text, /主会话/);
    assert.doesNotMatch(text, /Main session|run\b|done\b/);
  }
  const english = stripAnsi(renderMonitor({ tree, state: initialMonitorState(), width: 30, height: 20, nowMs: now }).lines.join('\n'));
  assert.match(english, /Main session/);
  assert.match(english, /1 run/);
});

test('the settings page lays Chinese labels out by display width', () => {
  const draft = { ...defaultSettings(), language: 'zh' as const };
  const selected = SETTING_ROWS.findIndex(row => row.key === 'language');
  assert.ok(selected >= 0, 'a Language row exists');
  for (const width of [18, 24, 32, 48]) {
    const frame = inChinese(() => renderSettingsPage({ draft, selected, offset: 0, message: '' }, width, 40));
    for (const line of frame.lines) assert.ok(visualLength(line) <= width, `${width}: ${stripAnsi(line)}`);
    if (width >= 32) {
      const text = stripAnsi(frame.lines.join('\n'));
      assert.match(text, /语言.*‹ 中文 ›/);
      assert.match(text, /\[返回\]/);
      for (const action of frame.actions) assert.ok(action.x + action.width <= width);
    }
  }
});

test('the brief is asked for in the panel language, and a switch asks again', async () => {
  assert.match(briefSystemPrompt('zh'), /Simplified Chinese/);
  assert.match(briefSystemPrompt('en'), /plain English/);
  assert.doesNotMatch(briefSystemPrompt('en'), /Chinese/);
  const omp = briefingCommand('omp', 'x', {}, 'en');
  assert.equal(omp.args[omp.args.indexOf('--system-prompt') + 1], briefSystemPrompt('en'));

  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-lang-bin-'));
  const calls = path.join(bin, 'calls');
  fs.writeFileSync(path.join(bin, 'omp'), `#!/bin/sh\necho call >> '${calls}'\necho '{"agents":[]}'\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const briefer = new Briefer(() => {});
    const settle = () => new Promise<void>(resolve => {
      const poll = () => briefer.current().running ? setTimeout(poll, 10) : resolve();
      poll();
    });
    briefer.update(tree, 'omp', 60_000, 'zh', now);
    await settle();
    briefer.update(tree, 'omp', 60_000, 'zh', now + 120_000);
    await settle();
    assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 1, 'same material, same language: no call');
    briefer.update(tree, 'omp', 60_000, 'en', now + 240_000);
    await settle();
    assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 2, 'another language: a new brief');
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
