import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PANEL_COMMANDS,
  commandSequence,
  isPanelCommand,
  monitorKey,
  overlayKey,
  needsOpenPanel,
} from '../../src/utils/panel-command.js';

test('Inspector commands have one descriptor and obsolete card commands are rejected', () => {
  assert.equal(monitorKey('inspect'), 'inspect');
  assert.equal(monitorKey('activate'), 'activate');
  assert.equal(overlayKey('activate', 'help'), 'enter');
  assert.equal(overlayKey('inspect', 'help'), 'enter');
  assert.equal(overlayKey('inspect', 'settings'), 'enter');
  assert.equal(needsOpenPanel('inspect'), true);
  assert.equal(isPanelCommand('open'), false);
  assert.equal(isPanelCommand('expand'), false);
  for (const command of PANEL_COMMANDS) {
    assert.equal(isPanelCommand(command), true);
    assert.equal(typeof monitorKey(command), 'string');
    assert.equal(commandSequence(command), `\x1b_codex-hud:${command}\x1b\\`);
  }
});

test('prefix keys bind Enter to Work activation, Space and v to inspect, omit e, and preserve compact folding', () => {
  const source = readFileSync(new URL('../../../bin/codex-hud-keys', import.meta.url), 'utf8');
  const bindings = [...source.matchAll(/^bind_command [01] (\S+) (\S+)$/gm)].map(([, key, command]) => ({
    key,
    command,
  }));
  assert.ok(bindings.some((b) => b.key === 'Enter' && b.command === 'activate'));
  for (const key of ['Space', 'v']) assert.ok(bindings.some((b) => b.key === key && b.command === 'inspect'));
  for (const key of ['r', 'b', 'R']) assert.ok(!bindings.some((b) => b.key === key));
  assert.ok(!bindings.some((b) => b.key === 'e'));
  assert.ok(bindings.some((b) => b.key === 'h' && b.command === 'left'));
  assert.ok(bindings.some((b) => b.key === 'l' && b.command === 'right'));
  for (const binding of bindings)
    assert.equal(isPanelCommand(binding.command), true, `${binding.key}: ${binding.command}`);
});
