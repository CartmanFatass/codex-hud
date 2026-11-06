import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveHudEnv, type HudEnvironmentName } from '../../src/utils/hud-env.js';
import { resolveDisplayConfig, displayConfig, setDisplayConfig } from '../../src/render/hud-config.js';
import { runtimeSettings, applyDisplaySettings } from '../../src/settings-runtime.js';
import { defaultSettings, saveSettings } from '../../src/settings.js';
import type { HudData } from '../../src/types.js';

const aliases: Array<[HudEnvironmentName, string, string]> = [
  ['HUD_SETTINGS_PATH', 'CODEX_HUD_SETTINGS_PATH', '/synthetic/settings with spaces.json'],
  ['HUD_THEME', 'CODEX_HUD_THEME', 'latte'],
  ['HUD_DENSITY', 'CODEX_HUD_DENSITY', 'focus'],
  ['HUD_GLYPHS', 'CODEX_HUD_GLYPHS', 'text'],
  ['HUD_ICONS', 'CODEX_HUD_ICONS', 'nerd'],
  ['HUD_LOOK', 'CODEX_HUD_LOOK', 'pill'],
  ['HUD_REDUCED_MOTION', 'CODEX_HUD_REDUCED_MOTION', '1'],
  ['HUD_CONTEXT', 'CODEX_HUD_CONTEXT', 'remaining'],
  ['HUD_TREE_WIDTH', 'CODEX_HUD_TREE_WIDTH', '72'],
  ['HUD_CLEAR_SCROLLBACK', 'CODEX_HUD_CLEAR_SCROLLBACK', '1'],
];

for (const [neutral, legacy, value] of aliases) {
  test(`E2 raw alias ${neutral}: presence wins without mutation or fallback`, () => {
    assert.equal(resolveHudEnv({}, neutral), undefined);
    assert.equal(resolveHudEnv({ [neutral]: value }, neutral), value);
    assert.equal(resolveHudEnv({ [legacy]: value }, neutral), value);
    assert.equal(resolveHudEnv({ [neutral]: undefined, [legacy]: value }, neutral), value);
    for (const raw of [value, '', 'invalid synthetic value']) {
      const env = Object.freeze({ [neutral]: raw, [legacy]: 'shadowed', UNRELATED: 'untouched' });
      const before = { ...env };
      assert.equal(resolveHudEnv(env, neutral), raw);
      assert.deepEqual(env, before);
    }
  });
}

test('E2 only the ten presentation/settings names map, never credentials or identity', () => {
  for (const name of [
    'HUD_BRIEF_API_KEY',
    'HUD_BRIEF_MODEL',
    'HUD_HOME',
    'HUD_LINK',
    'HUD_HEIGHT',
    'HUD_SOCKET',
    'HUD_UNKNOWN',
    'toString',
    '__proto__',
  ]) {
    const env = { [name]: 'neutral', [`CODEX_${name}`]: 'legacy' };
    assert.equal(resolveHudEnv(env, name as HudEnvironmentName), undefined);
  }
});

test('E2 display consumers preserve parsing, defaults, neutral precedence and NO_COLOR', () => {
  const neutral = Object.fromEntries(aliases.slice(1, 8).map(([name, , value]) => [name, value]));
  const legacy = Object.fromEntries(aliases.slice(1, 8).map(([, name, value]) => [name, value]));
  const defaults = resolveDisplayConfig({});
  assert.deepEqual(resolveDisplayConfig(neutral), resolveDisplayConfig(legacy));
  assert.deepEqual(resolveDisplayConfig(neutral), {
    ...defaults,
    theme: 'latte',
    density: 'focus',
    glyphs: 'text',
    icons: 'nerd',
    look: 'pill',
    motion: 'reduced',
    context: 'remaining',
  });
  const conflicts = Object.fromEntries(aliases.slice(1, 8).map(([, name]) => [name, 'invalid']));
  assert.deepEqual(resolveDisplayConfig({ ...conflicts, ...neutral }), resolveDisplayConfig(neutral));
  for (const value of ['', 'invalid']) {
    const invalid = Object.fromEntries(aliases.slice(1, 8).map(([name]) => [name, value]));
    assert.deepEqual(resolveDisplayConfig({ ...legacy, ...invalid }), defaults);
  }
  assert.equal(resolveDisplayConfig({ HUD_THEME: ' LATTE ' }).theme, 'latte');
  assert.equal(resolveDisplayConfig({ HUD_REDUCED_MOTION: ' 1 ' }).motion, 'full');
  assert.equal(resolveDisplayConfig({ ...neutral, NO_COLOR: '1' }).theme, 'none');
  assert.equal(resolveDisplayConfig({ ...neutral, NO_COLOR: '' }).theme, 'latte');
});

function isolated(run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-env-'));
  const names = [...aliases.flatMap(([a, b]) => [a, b]), 'HOME', 'HUD_HOME', 'CODEX_HOME', 'NO_COLOR'];
  const before = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    process.env.HOME = root;
    process.env.HUD_HOME = path.join(root, 'ledger');
    process.env.CODEX_HOME = path.join(root, 'codex');
    run(root);
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('E2 runtime defaults use aliases, bounded width and saved settings priority; NO_COLOR stays final', () => {
  isolated(() => {
    assert.deepEqual(runtimeSettings(), defaultSettings());
    for (const [neutral, legacy, value] of aliases.slice(1, 9)) {
      process.env[legacy] = value;
      const old = runtimeSettings();
      delete process.env[legacy];
      process.env[neutral] = value;
      assert.deepEqual(runtimeSettings(), old);
      delete process.env[neutral];
    }
    process.env.CODEX_HUD_TREE_WIDTH = '99';
    for (const width of ['16', '200', '72']) {
      process.env.HUD_TREE_WIDTH = width;
      assert.equal(runtimeSettings().treeWidth, Number(width));
    }
    for (const width of ['', 'invalid', '0', '15', '201', '40.5']) {
      process.env.HUD_TREE_WIDTH = width;
      assert.equal(runtimeSettings().treeWidth, 48, width);
    }
    process.env.HUD_THEME = 'mocha';
    process.env.HUD_DENSITY = 'focus';
    process.env.HUD_TREE_WIDTH = '100';
    saveSettings({ theme: 'latte', density: 'full', treeWidth: 32 });
    const saved = runtimeSettings();
    assert.equal(saved.theme, 'latte');
    assert.equal(saved.density, 'full');
    assert.equal(saved.treeWidth, 32);
    const previous = displayConfig();
    try {
      process.env.NO_COLOR = '1';
      applyDisplaySettings(saved);
      assert.equal(displayConfig().theme, 'none');
      assert.equal(saved.theme, 'latte');
    } finally {
      setDisplayConfig(previous);
    }
  });
});

// Real renderer in a fresh process per case: first-frame state and stdout are not mocked.
const renderData: HudData = {
  config: { model: 'synthetic-model', model_provider: 'synthetic' },
  git: {
    branch: null,
    isDirty: false,
    isGitRepo: false,
    ahead: 0,
    behind: 0,
    modified: 0,
    added: 0,
    deleted: 0,
    untracked: 0,
  },
  project: {
    cwd: '/synthetic/project',
    projectName: 'synthetic-a',
    agentsMdCount: 0,
    hasCodexDir: false,
    instructionsMdCount: 0,
    rulesCount: 0,
    mcpCount: 0,
    configsCount: 0,
    extensionsCount: 0,
    workMode: 'development',
  },
  sessionStart: new Date('2026-01-01T00:00:00Z'),
  displayMode: 'single',
};

test('E2 renderer clears only its first frame using the selected raw alias', () => {
  isolated((root) => {
    const module = new URL('../../src/render/index.js', import.meta.url).href;
    const script = `
      import { renderToStdout } from ${JSON.stringify(module)};
      const data = ${JSON.stringify(renderData)};
      data.sessionStart = new Date(data.sessionStart);
      renderToStdout(data, 1);
      process.stdout.write('\\nSYNTHETIC_FRAME_BOUNDARY\\n');
      renderToStdout(data, 2);
    `;
    for (const [env, clears] of [
      [{}, 0],
      [{ CODEX_HUD_CLEAR_SCROLLBACK: '1' }, 1],
      [{ HUD_CLEAR_SCROLLBACK: '1' }, 1],
      [{ HUD_CLEAR_SCROLLBACK: '1', CODEX_HUD_CLEAR_SCROLLBACK: '0' }, 1],
      [{ HUD_CLEAR_SCROLLBACK: '', CODEX_HUD_CLEAR_SCROLLBACK: '1' }, 0],
      [{ HUD_CLEAR_SCROLLBACK: 'invalid', CODEX_HUD_CLEAR_SCROLLBACK: '1' }, 0],
    ] as Array<[NodeJS.ProcessEnv, number]>) {
      const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          HOME: root,
          HUD_HOME: path.join(root, 'ledger'),
          CODEX_HOME: path.join(root, 'codex'),
          COLUMNS: '80',
          LINES: '5',
          ...env,
        },
      });
      assert.equal(child.status, 0, child.stderr);
      const [first, second] = child.stdout.split('\nSYNTHETIC_FRAME_BOUNDARY\n');
      assert.equal((first.match(/\x1b\[3J/g) ?? []).length, clears);
      assert.ok(first.includes('\x1b[2J'), 'first frame still clears the screen');
      assert.ok(second.includes('\x1b[H'), 'a changed subsequent frame is rendered');
      assert.ok(!second.includes('\x1b[3J'));
      assert.ok(!second.includes('\x1b[2J'));
    }
  });
});
