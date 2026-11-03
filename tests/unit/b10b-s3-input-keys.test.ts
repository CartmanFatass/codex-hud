/**
 * B10B-s3: the four keys of the delegation view (design §2, §3.7; rulings B10B-s3 Q5): `n` and `N` (next and previous
 * trouble), `L` (log), `R` (resume or reconcile). They are named in the decoder, bound in the tmux prefix table
 * without repeat, and do nothing while the panel is closed. Every other key is as it was.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { stripAnsi } from '../../src/render/colors.js';
import { setLanguage } from '../../src/render/i18n.js';
import { renderMonitor } from '../../src/render/monitor.js';
import {
  PANEL_COMMANDS,
  commandSequence,
  isPanelCommand,
  monitorKey,
  needsOpenPanel,
  overlayKey,
} from '../../src/utils/panel-command.js';
import { WorkbenchInputDecoder } from '../../src/utils/workbench-input.js';
import { situationC } from '../fixtures/b10b-delegation.js';
import { monitorInput } from '../fixtures/b10b-s3.js';

const root = process.cwd();

/** The decoder’s map of single keys before the four were added: every one of them is asserted unchanged. */
const LEGACY: Record<string, string> = {
  j: 'down',
  k: 'up',
  h: 'left',
  l: 'right',
  g: 'home',
  G: 'end',
  '\t': 'tab',
  '\r': 'enter',
  '\n': 'enter',
  ' ': 'enter',
  q: 'close',
  Q: 'close',
  '\x03': 'close',
  '\x04': 'close',
  a: 'show-all',
  v: 'detail-toggle',
  r: 'reset',
  ',': 'settings',
  m: 'main',
  o: 'open-session',
  f: 'filter',
  '/': 'filter',
  s: 'sort',
  z: 'zoom',
  '?': 'help',
  b: 'brief-toggle',
  x: 'pane-close',
  d: 'diagnostics',
  '[': 'previous-tab',
  ']': 'next-tab',
  t: 'next-tab',
  '1': 'agents',
  '2': 'details',
  '3': 'changes',
  '4': 'activity',
};
const NEW: Record<string, string> = {
  n: 'next-trouble',
  N: 'previous-trouble',
  L: 'log',
  R: 'resume-reconcile',
};

test('the decoder names n, N, L and R, and every other key (all of ASCII) is exactly what it was, in both profiles', () => {
  for (const profile of ['monitor', 'workbench'] as const)
    for (const forward of [true, false]) {
      for (let code = 0; code < 128; code++) {
        if (code === 0x1b) continue;
        const ch = String.fromCharCode(code);
        const inputs = new WorkbenchInputDecoder(profile, { forward }).push(Buffer.from(ch));
        const expected =
          NEW[ch] ??
          (profile === 'monitor' && ch === '2'
            ? 'timeline'
            : profile === 'monitor' && ch === '4'
              ? 'details'
              : LEGACY[ch]);
        const label = `${profile}/${forward ? 'forward' : 'plain'}/${JSON.stringify(ch)}`;
        if (expected === undefined) {
          // An unnamed key: dropped, or, when keys are forwarded, passed on with no name.
          assert.deepEqual(inputs, forward ? [{ type: 'key', key: '', raw: ch }] : [], label);
        } else
          assert.deepEqual(
            inputs,
            [forward ? { type: 'key', key: expected, raw: ch } : { type: 'key', key: expected }],
            label
          );
      }
    }
});

test('the four commands are panel commands, mapped to keys of their own; R is named for both its words', () => {
  for (const command of Object.values(NEW)) {
    assert.ok(isPanelCommand(command), command);
    assert.ok(PANEL_COMMANDS.includes(command as never));
    assert.equal(monitorKey(command as never), command);
    assert.match(command, /^[a-z0-9-]{1,32}$/, 'a name the command script and the decoder accept');
    // Delivered as the APC string, the decoder gives the command back whole, split or not.
    const decoder = new WorkbenchInputDecoder('monitor', { forward: true });
    assert.deepEqual(decoder.push(Buffer.from(commandSequence(command as never))), [{ type: 'command', command }]);
  }
  assert.equal(NEW.R, 'resume-reconcile');
  assert.equal(PANEL_COMMANDS.length, 36);
  // The map of every other command is as it was.
  assert.equal(monitorKey('older'), 'show-all');
  assert.equal(monitorKey('switch'), 'open-session');
  assert.equal(monitorKey('level'), 'reset');
  assert.equal(monitorKey('inspect'), 'enter');
});

test('with the panel closed all four do nothing; every other command is as it was', () => {
  for (const command of Object.values(NEW)) assert.equal(needsOpenPanel(command as never), false, command);
  const staysOpening = PANEL_COMMANDS.filter((c) => !Object.values(NEW).includes(c));
  const doNothing = staysOpening.filter((c) => !needsOpenPanel(c));
  assert.deepEqual(doNothing.sort(), [
    'back',
    'down',
    'first',
    'last',
    'left',
    'page-down',
    'page-up',
    'quit',
    'right',
    'up',
  ]);
  // An open overlay does not take them for its own: the command closes it and runs (like `order`, `filter`).
  for (const command of Object.values(NEW)) {
    assert.equal(overlayKey(command as never, 'help'), null);
    assert.equal(overlayKey(command as never, 'settings'), null);
  }
});

test('the prefix table binds the four, never repeating, and the closed-panel script does nothing for them', (t) => {
  const source = fs.readFileSync(path.join(root, 'bin/codex-hud-keys'), 'utf8');
  const bindings = [...source.matchAll(/^bind_command ([01]) (\S+) (\S+)$/gm)].map(([, repeat, key, command]) => ({
    repeat,
    key,
    command,
  }));
  for (const [key, command] of Object.entries(NEW)) {
    const bound = bindings.filter((b) => b.key === key);
    assert.deepEqual(bound, [{ repeat: '0', key, command }], `${key}: bound once, with no repeat`);
  }
  // Nothing else moved: j and k still repeat, h and l do not.
  assert.deepEqual(
    bindings
      .filter((b) => b.repeat === '1')
      .map((b) => b.key)
      .sort(),
    ['Down', 'NPage', 'PPage', 'Up', 'j', 'k']
  );
  for (const b of bindings) assert.ok(isPanelCommand(b.command), `${b.key}: ${b.command}`);

  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-s3-'));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const log = path.join(bin, 'tmux.log');
  fs.writeFileSync(
    path.join(bin, 'tmux'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
case "$1" in
  display-message) printf '\\n' ;;
  show-option) printf '%%1\\n' ;;
esac
exit 0
`,
    { mode: 0o755 }
  );
  const toggled = path.join(bin, 'toggled');
  fs.copyFileSync(path.join(root, 'bin/codex-hud-command'), path.join(bin, 'codex-hud-command'));
  fs.writeFileSync(path.join(bin, 'codex-hud-toggle'), `printf '%s\\n' "$*" >> ${JSON.stringify(toggled)}\n`);
  const run = (command: string) =>
    execFileSync('bash', [path.join(bin, 'codex-hud-command'), '$1', command], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      stdio: 'ignore',
    });
  for (const command of Object.values(NEW)) run(command);
  assert.ok(!fs.existsSync(toggled), 'a closed panel is not opened by n, N, L or R');
  run('help');
  assert.equal(fs.readFileSync(toggled, 'utf8').trim(), '$1 --command help', 'and any other command still opens it');
});

test('help lists the four keys only where the delegation view is drawn; the legacy help is the same with or without them', () => {
  const help = (vm: ReturnType<typeof situationC>['vm'] | null | undefined, width = 60) => {
    const input = monitorInput(vm, { width, height: 40 });
    input.state.help = true;
    return renderMonitor(input).lines.map(stripAnsi);
  };
  const c = situationC();
  const withDelegation = help(c.vm).join('\n');
  assert.match(withDelegation, /n N\s+next \/ previous trouble/);
  assert.match(withDelegation, /\bL\s+log/);
  assert.match(withDelegation, /\bR\s+resume \/ reconcile/);
  for (const none of [undefined, null]) {
    const legacy = help(none).join('\n');
    assert.ok(!/trouble|resume \/ reconcile|\bL\s+log/.test(legacy), 'the legacy help has none of them');
  }
  assert.deepEqual(help(null), help(undefined), 'a null view model is the legacy help byte for byte');
  const previous = setLanguage('zh');
  try {
    const zh = help(c.vm).join('\n');
    assert.match(zh, /下一个 \/ 上一个异常/);
    assert.match(zh, /恢复 \/ 对账/);
  } finally {
    setLanguage(previous);
  }
});

test('the references list the keys in their Keys sections, English and Chinese', () => {
  const en = fs.readFileSync(path.join(root, 'docs/reference.md'), 'utf8');
  const zh = fs.readFileSync(path.join(root, 'docs/reference.zh.md'), 'utf8');
  for (const doc of [en, zh]) {
    assert.match(doc, /^\| `n` \/ `N` \|/m);
    assert.match(doc, /^\| `L` \|/m);
    assert.match(doc, /^\| `R` \|/m);
  }
});
