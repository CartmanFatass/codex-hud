#!/usr/bin/env node
/** Run real assertion suites against one mutated emitted implementation/template at a time. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const mutants = [
  {
    name: 'prefix-wildcard',
    file: 'integrations/claude/hook.js',
    old: "!['hud:hud', 'hud', 'hud:setup'].includes(name)",
    replacement: "!['hud:hud', 'hud', 'hud:setup'].some(command => name.startsWith(command))",
    test: 'exact command grammar',
  },
  {
    name: 'parent-env-leak',
    file: 'integrations/claude/mcp.js',
    old: 'return {',
    replacement: "parent.HUD_MCP_SURFACE = 'roles'; return {",
    test: 'MCP env is child-only',
  },
  {
    name: 'hook-json-eligibility',
    file: 'integrations/claude/hook.js',
    old: 'const { context, native, herdr } = captured;',
    replacement: 'const { context, herdr } = captured; const native = input.native ?? captured.native;',
    test: 'hook JSON native claims',
  },
  {
    name: 'old-end-new-generation',
    file: 'integrations/claude/hook.js',
    old: 'if (input.session_id !== context.target.ref.sessionId)',
    replacement: "if (input.hook_event_name !== 'SessionEnd' && input.session_id !== context.target.ref.sessionId)",
    test: 'SessionStart opens once',
  },
  { name: 'manifest-statusline', template: true, test: 'templates: one discovery manifest' },
  {
    name: 'missing-provider-control-proof',
    generator: true,
    file: 'claude.mjs',
    old: '!Number.isSafeInteger(evidence?.ordinaryRequests) ||',
    replacement: '',
    test: 'bare alias is NOT_VERIFIED',
  },
];
let killed = 0;
for (const m of mutants) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'hud-claude-mutant-'));
  fs.chmodSync(root, 0o700);
  try {
    const emitted = path.join(root, 'dist');
    fs.cpSync('dist', emitted, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    for (const name of ['@iarna/toml', 'chokidar', 'readdirp'])
      fs.cpSync(path.join('node_modules', name), path.join(root, 'node_modules', name), { recursive: true });
    if (m.template) {
      fs.cpSync('integrations', path.join(root, 'integrations'), { recursive: true });
      const file = path.join(root, 'integrations/claude/plugin.template.json');
      const value = JSON.parse(fs.readFileSync(file));
      value.statusLine = { command: 'unexpected' };
      fs.writeFileSync(file, JSON.stringify(value));
    } else {
      if (m.generator) fs.cpSync('scripts/runtime-package', path.join(root, 'runtime-package'), { recursive: true });
      const file = path.join(m.generator ? path.join(root, 'runtime-package') : emitted, m.file),
        text = fs.readFileSync(file, 'utf8');
      if (!text.includes(m.old)) throw Error('mutation_anchor_missing: ' + m.name);
      fs.writeFileSync(file, text.replace(m.old, m.replacement));
    }
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { mode: 0o700 });
    for (const dir of ['hud', 'codex', '.claude']) fs.mkdirSync(path.join(home, dir), { mode: 0o700 });
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      HUD_HOME: path.join(home, 'hud'),
      CODEX_HOME: path.join(home, 'codex'),
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      R6A_CLAUDE_EMITTED_ROOT: emitted,
      ...(m.template ? { R6A_CLAUDE_TEMPLATE_ROOT: root } : {}),
      ...(m.generator ? { R6A_CLAUDE_GENERATOR_MODULE: path.join(root, 'runtime-package/claude.mjs') } : {}),
    };
    const out = spawnSync(
      process.execPath,
      ['--test', '--test-name-pattern', m.test, 'tests/unit/claude-plugin.test.mjs'],
      { env, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 }
    );
    if (out.status !== 0 && !out.error && /AssertionError|invalid_claude_manifest/.test(out.stdout + out.stderr)) {
      killed++;
      console.log(`KILLED ${m.name}`);
    } else {
      console.error(`SURVIVED/INCONCLUSIVE ${m.name}\n${out.stdout}\n${out.stderr}`);
      process.exitCode = 1;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
console.log(`${killed}/${mutants.length} mutants killed`);
