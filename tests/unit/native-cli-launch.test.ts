import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeCommand } from '../../src/cli/launcher.js';

for (const version of ['2.1.305', '99.0.0-next']) {
  test(`ordinary Claude launch/resume preserves settings without vendor qualification: ${version}`, async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'hud-native-cli-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const executable = join(root, 'claude');
    // A synthetic updated executable is only discovered, never run in this fixture.
    writeFileSync(executable, `#!/bin/sh\necho '${version}'\n`);
    chmodSync(executable, 0o700);
    const profile = {
      name: 'native-claude',
      harness: 'claude',
      source: { root, label: 'Synthetic' },
      launch: { argv: [executable] },
      // No legacy host/claim/timeout/retirement policy is needed for native launch.
      env: {},
      mcpServerName: 'hud',
      callSource: { kind: 'claude_pre_tool_use_v1' },
    };
    writeFileSync(join(root, 'delegate.json'), JSON.stringify({ version: 1, profiles: [profile] }));
    const settings = {
      permissions: { allow: ['synthetic'] },
      hooks: { PreToolUse: [{ matcher: 'existing', hooks: [] }] },
    };
    const baseline = readdirSync(root);
    let launches = 0;
    for (const args of [[], ['--resume', 'synthetic-session']]) {
      assert.equal(
        await claudeCommand(
          [...args, '--settings', JSON.stringify(settings)],
          root,
          {
            env: {
              HOME: root,
              HUD_HOME: root,
              HUD_CLAUDE_HOOK_CONFIG: '/stale/other-session',
              HUD_THEME: 'preserved',
              HUD_CLAIM: 'stale',
            },
            stdout: () => {},
            stderr: () => {},
          },
          {
            verify: async () => {
              throw new Error('no qualification verifier');
            },
            production: {
              manifest: () => {
                throw new Error('no manifest');
              },
              observe: async () => {
                throw new Error('no tmux qualification');
              },
            },
            launch: async (command, env) => {
              launches++;
              assert.equal(command.argv![0], executable);
              if (args.length) assert.deepEqual(command.argv!.slice(1, 3), args);
              const merged = JSON.parse(readFileSync(command.argv![command.argv!.indexOf('--settings') + 1], 'utf8'));
              assert.deepEqual(merged.permissions, settings.permissions);
              assert.deepEqual(merged.hooks.PreToolUse[0], settings.hooks.PreToolUse[0]);
              assert.equal(merged.hooks.PreToolUse.length, 2);
              const hook = JSON.parse(readFileSync(env.HUD_CLAUDE_HOOK_CONFIG!, 'utf8'));
              assert.equal(hook.claudeExecutable, executable);
              assert.equal(hook.claudeVersion, undefined);
              assert.equal(hook.ledgerPath, undefined);
              assert.equal(hook.sourceRoot, root);
              assert.equal(env.HUD_THEME, 'preserved');
              assert.equal(env.HUD_CLAIM, undefined);
              return 0;
            },
          }
        ),
        0
      );
      assert.deepEqual(readdirSync(root), baseline);
    }
    assert.equal(launches, 2);
  });
}
