import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorkbenchInputDecoder } from '../../src/utils/workbench-input.js';
import {
  commandSequence,
  monitorKey,
  needsOpenPanel,
  overlayKey,
  PANEL_COMMANDS,
  prefixName,
} from '../../src/utils/panel-command.js';

const root = process.cwd();

/**
 * A tmux that only writes down what it was asked, one line per call, and
 * answers the few questions the scripts ask from the environment. The real
 * server is never reached.
 */
function fakeTmux(): { dir: string; log: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-keys-'));
  const log = path.join(dir, 'tmux.log');
  fs.writeFileSync(
    path.join(dir, 'tmux'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
case "$1" in
  display-message) printf '%s\\n' "\${FAKE_TREE_PANE:-}" ;;
  show-option)
    case "$*" in
      *@codex_hud_prefix_key*) printf '%s\\n' "\${FAKE_OLD_PREFIX:-}" ;;
      *@codex_hud_main_pane*) printf '%s\\n' "\${FAKE_MAIN_PANE:-}" ;;
    esac ;;
  send-keys) exit "\${FAKE_SEND_STATUS:-0}" ;;
  list-keys) exit 1 ;;
esac
exit 0
`,
    { mode: 0o755 }
  );
  return { dir, log };
}

function run(script: string, args: string[], fake: { dir: string }, env: Record<string, string> = {}): void {
  execFileSync('bash', [script, ...args], {
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, ...env },
    stdio: 'ignore',
  });
}

const calls = (log: string) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);

test('a command reaches the decoder whole, split, or among keys; nothing else is taken for one', () => {
  const decoder = new WorkbenchInputDecoder('monitor', { forward: true });
  assert.deepEqual(decoder.push(Buffer.from(commandSequence('settings'))), [{ type: 'command', command: 'settings' }]);
  const seq = commandSequence('down');
  assert.deepEqual(decoder.push(Buffer.from(seq.slice(0, 7))), []);
  assert.deepEqual(decoder.push(Buffer.from(seq.slice(7) + 'x')), [
    { type: 'command', command: 'down' },
    { type: 'key', key: 'pane-close', raw: 'x' },
  ]);
  // An unknown name is dropped, never typed.
  assert.deepEqual(decoder.push(Buffer.from('\x1b_codex-hud:rm-rf\x1b\\')), []);
  // Alt+_ and then typing: not a command, so the keys as they came.
  assert.deepEqual(decoder.push(Buffer.from('\x1b_ay')), [
    { type: 'key', key: '', raw: '\x1b_' },
    { type: 'key', key: 'show-all', raw: 'a' },
    { type: 'key', key: '', raw: 'y' },
  ]);
  // The start of one that never finishes is keys once the escape timer runs.
  assert.deepEqual(decoder.push(Buffer.from('\x1b_cod')), []);
  assert.deepEqual(decoder.flushEscape(), [{ type: 'key', key: '', raw: '\x1b_cod' }]);
  // Without forwarding, commands still arrive.
  assert.deepEqual(new WorkbenchInputDecoder('monitor').push(Buffer.from(commandSequence('help'))), [
    { type: 'command', command: 'help' },
  ]);
});

test('commands are names: r is the status level on the panel, never Reset on the settings page', () => {
  assert.equal(monitorKey('level'), 'reset');
  assert.equal(overlayKey('level', 'settings'), null, 'closes settings and goes to the panel');
  assert.equal(overlayKey('order', 'settings'), null, 'not Save');
  assert.equal(overlayKey('settings', 'settings'), 'escape');
  assert.equal(overlayKey('help', 'help'), 'escape');
  assert.equal(overlayKey('down', 'help'), 'down');
  assert.equal(overlayKey('back', 'settings'), 'escape');
  for (const c of PANEL_COMMANDS) assert.ok(monitorKey(c), c);
  assert.equal(needsOpenPanel('settings'), true);
  assert.equal(needsOpenPanel('down'), false);
  assert.equal(needsOpenPanel('quit'), false);
  assert.equal(prefixName('C-]'), 'Ctrl+]');
  assert.equal(prefixName('C-\\'), 'Ctrl+\\');
});

test('codex-hud-keys binds the prefix in the session table, the commands in their own, and never the root table', () => {
  const fake = fakeTmux();
  run(path.join(root, 'bin/codex-hud-keys'), ['hud-1', 'C-]'], fake);
  const log = calls(fake.log);
  assert.ok(log.includes('bind-key -T codex-hud C-] switch-client -T codex-hud-prefix'), log.join('\n'));
  assert.ok(log.includes('bind-key -T codex-hud-prefix C-] send-keys C-]'), 'the prefix twice is the key itself');
  assert.ok(
    log.some((l) =>
      /^bind-key -T codex-hud-prefix , run-shell bash \S+codex-hud-command '#\{session_id\}' settings$/.test(l)
    )
  );
  assert.ok(
    log.some((l) => /^bind-key -r -T codex-hud-prefix j run-shell .* down$/.test(l)),
    'j repeats'
  );
  assert.ok(!log.some((l) => /^bind-key -T codex-hud-prefix - /.test(l)), 'panes open and close; nothing folds');
  assert.ok(log.includes('unbind-key -a -T codex-hud-prefix'), 'rebuilt from nothing');
  assert.ok(log.includes('set-option -gq @codex_hud_prefix_key C-]'));
  assert.ok(log.includes('set-option -t hud-1 repeat-time 500'));
  assert.ok(
    !log.some((l) => /-T (root|prefix) /.test(l) && !l.startsWith('list-keys')),
    'root and prefix tables untouched'
  );
});

test('a changed prefix takes the old one out of the session table', () => {
  const fake = fakeTmux();
  run(path.join(root, 'bin/codex-hud-keys'), ['hud-1', 'C-\\'], fake, { FAKE_OLD_PREFIX: 'C-]' });
  const log = calls(fake.log);
  assert.ok(log.includes('unbind-key -T codex-hud C-]'), log.join('\n'));
  assert.ok(log.includes('bind-key -T codex-hud C-\\ switch-client -T codex-hud-prefix'));
  // Anything else is the default.
  const other = fakeTmux();
  run(path.join(root, 'bin/codex-hud-keys'), ['hud-1', 'C-b'], other);
  assert.ok(calls(other.log).includes('bind-key -T codex-hud C-] switch-client -T codex-hud-prefix'));
});

test('codex-hud-keys reads the prefix from the settings file when none is given', () => {
  const fake = fakeTmux();
  const file = path.join(fake.dir, 'hud-settings.json');
  fs.writeFileSync(file, JSON.stringify({ prefixKey: 'C-\\' }));
  run(path.join(root, 'bin/codex-hud-keys'), ['hud-1'], fake, { CODEX_HUD_SETTINGS_PATH: file });
  assert.ok(calls(fake.log).includes('bind-key -T codex-hud C-\\ switch-client -T codex-hud-prefix'));
});

test('codex-hud-command: to the open panel as its APC string; a closed one is opened with the command, or left alone', () => {
  const fake = fakeTmux();
  // The real script beside a toggle that only records how it was called.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-cmd-'));
  fs.copyFileSync(path.join(root, 'bin/codex-hud-command'), path.join(bin, 'codex-hud-command'));
  const toggled = path.join(bin, 'toggled');
  fs.writeFileSync(path.join(bin, 'codex-hud-toggle'), `printf '%s\\n' "$*" >> ${JSON.stringify(toggled)}\n`);
  const script = path.join(bin, 'codex-hud-command');

  run(script, ['$1', 'settings'], fake, { FAKE_TREE_PANE: '%7' });
  const hex = Buffer.from(commandSequence('settings')).toString('hex').match(/../g)!.join(' ');
  const sent = calls(fake.log).find((l) => l.startsWith('send-keys'))!;
  assert.equal(sent.replace(/\s+/g, ' ').trim(), `send-keys -t %7 -H ${hex}`);
  assert.ok(!fs.existsSync(toggled));

  // Closed: navigation does nothing, anything else opens the panel with it.
  run(script, ['$1', 'down'], fake, { FAKE_TREE_PANE: '', FAKE_MAIN_PANE: '%1' });
  assert.ok(!fs.existsSync(toggled));
  run(script, ['$1', 'help'], fake, { FAKE_TREE_PANE: '', FAKE_MAIN_PANE: '%1' });
  assert.equal(fs.readFileSync(toggled, 'utf8').trim(), '$1 --command help');
  // A dead pane id is the same as none.
  run(script, ['$1', 'brief'], fake, { FAKE_TREE_PANE: '%9', FAKE_SEND_STATUS: '1', FAKE_MAIN_PANE: '%1' });
  assert.equal(fs.readFileSync(toggled, 'utf8').trim().split('\n')[1], '$1 --command brief');
  // No HUD here, nothing to open; and a name that is not a command is refused.
  run(script, ['$1', 'brief'], fake, { FAKE_TREE_PANE: '' });
  run(script, ['$1', 'x; rm -rf /'], fake, { FAKE_TREE_PANE: '%7' });
  assert.equal(fs.readFileSync(toggled, 'utf8').trim().split('\n').length, 2);
});
