import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import {
  clearExhausted,
  harnessDefaults,
  markExhausted,
  placeCatalog,
  placeKey,
  readExhausted,
  roleRegistry,
  writeRolePlaces,
} from '../../dist/roles/roster.js';

const bundled = resolve('packages/hud-mcp');
const mcpEntry = resolve('packages/hud-mcp/bin/hud-mcp.mjs');

function makeSandbox(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'role-writes-'));
  const hud = join(root, 'hud');
  const cwd = join(root, 'cwd');
  const bin = join(root, 'bin');
  fs.mkdirSync(hud, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  for (const cmd of ['pi-role', 'herdr', 'agy', 'claude', 'codex', 'grok', 'jev-ask', 'jev-aistudio', 'jev-flow']) {
    fs.writeFileSync(join(bin, cmd), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, hud, cwd, bin, env: { PATH: bin } };
}

test('placeCatalog returns shipped defaults and merges HUD_HOME catalog additions', (t) => {
  const s = makeSandbox(t);
  const base = placeCatalog(s.hud, bundled);
  assert.deepEqual(base.pi.models, [
    'openai/gpt-6.1-sol',
    'openai/gpt-6-astra',
    'mistral/deepseek-v4-1-flash-1017',
    'arena/gpt-6.1-sol',
  ]);
  assert.deepEqual(base.pi.thinking, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(base.cli.agents, ['agy', 'claude', 'codex', 'grok']);
  assert.deepEqual(base.cli.models, {
    agy: ['gemini-4-argon-high', 'gemini-4-hydrogen-high', 'gemini-3.8-flash-high'],
    claude: ['opus', 'sonnet', 'haiku'],
    codex: ['gpt-6.1-sol', 'gpt-6-luna'],
    grok: ['grok-4.7'],
  });
  assert.deepEqual(base.cli.thinking, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(base.bro, {
    tools: ['jev-ask', 'jev-aistudio', 'jev-flow'],
    providers: ['chatgpt', 'gemini'],
    kinds: ['image', 'video'],
    models: {
      chatgpt: ['6 Pro'],
      'jev-aistudio': ['gemini-4-argon'],
    },
  });

  // Additions via $HUD_HOME/harnesses.json catalog key deduplicate and keep harnessDefaults working.
  fs.writeFileSync(
    join(s.hud, 'harnesses.json'),
    JSON.stringify({
      agy: { model: 'gemini-4-hydrogen-high' },
      catalog: {
        pi: { models: ['openai/gpt-6.1-sol', 'custom/pi-next'], thinking: ['custom-think'] },
        cli: {
          agents: ['bogus-agent'],
          models: {
            agy: ['gemini-4-hydrogen-high', 'gemini-5-preview'],
            codex: ['gpt-6.2-preview'],
            bogus: ['ignored'],
          },
          thinking: ['high', 'ultra'],
        },
        bro: {
          tools: ['bogus-tool'],
          providers: ['bogus-provider'],
          kinds: ['bogus-kind'],
          models: { 'jev-aistudio': ['gemini-4-argon', 'gemini-4-ultra'], 'jev-flow': ['veo-3'] },
        },
      },
    })
  );

  const extended = placeCatalog(s.hud, bundled);
  assert.deepEqual(extended.pi.models, [
    'openai/gpt-6.1-sol',
    'openai/gpt-6-astra',
    'mistral/deepseek-v4-1-flash-1017',
    'arena/gpt-6.1-sol',
    'custom/pi-next',
  ]);
  assert.ok(extended.pi.thinking.includes('custom-think'));
  assert.deepEqual(extended.cli.agents, ['agy', 'claude', 'codex', 'grok']);
  assert.deepEqual(extended.cli.models.agy, [
    'gemini-4-argon-high',
    'gemini-4-hydrogen-high',
    'gemini-3.8-flash-high',
    'gemini-5-preview',
  ]);
  assert.deepEqual(extended.cli.models.codex, ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6.2-preview']);
  assert.deepEqual(extended.cli.thinking, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(extended.bro.tools, ['jev-ask', 'jev-aistudio', 'jev-flow']);
  assert.deepEqual(extended.bro.providers, ['chatgpt', 'gemini']);
  assert.deepEqual(extended.bro.kinds, ['image', 'video']);
  assert.deepEqual(extended.bro.models['jev-aistudio'], ['gemini-4-argon', 'gemini-4-ultra']);
  assert.deepEqual(extended.bro.models['jev-flow'], ['veo-3']);

  const defaults = harnessDefaults(s.hud, bundled);
  assert.equal(defaults.agy.model, 'gemini-4-hydrogen-high');
  assert.equal(defaults.catalog, undefined);
});

test('writeRolePlaces seeds from shipped role, preserves existing fields, sets 0600, and leaves shipped/project untouched', async (t) => {
  const s = makeSandbox(t);
  const shippedImpBefore = fs.readFileSync(join(bundled, 'roles', 'imp.json'), 'utf8');

  // Register a project with its own .hud/roles/imp.json to verify it is never modified or seeded from.
  const projRoles = join(s.cwd, '.hud', 'roles');
  fs.mkdirSync(projRoles, { recursive: true });
  const projImpPath = join(projRoles, 'imp.json');
  const projImpText = JSON.stringify({
    role: 'imp',
    harness: 'pi',
    pi_role: 'implementer',
    split: false,
    can_continue: true,
    project_only: true,
  });
  fs.writeFileSync(projImpPath, projImpText);
  fs.writeFileSync(join(s.hud, 'projects.json'), JSON.stringify({ version: 1, projects: [{ root: s.cwd }] }));

  // 1. No $HUD_HOME/roles/imp.json yet -> starts from shipped imp.json fields.
  const writtenPath = writeRolePlaces(
    s.hud,
    'imp',
    [
      { harness: 'cli', agent: 'agy', model: 'gemini-4-hydrogen-high', thinking: 'high' },
      { harness: 'pi', pi_role: 'implementer', split: false, model: 'openai/gpt-6.1-sol' },
    ],
    bundled
  );
  assert.equal(writtenPath, join(s.hud, 'roles', 'imp.json'));
  assert.equal(fs.statSync(writtenPath).mode & 0o777, 0o600);
  assert.deepEqual(
    fs.readdirSync(join(s.hud, 'roles')).filter((name) => name.endsWith('.tmp')),
    []
  );

  const written1 = JSON.parse(fs.readFileSync(writtenPath, 'utf8'));
  assert.equal(written1.role, 'imp');
  assert.equal(written1.instructions, 'implementer');
  assert.equal(written1.can_continue, true);
  assert.equal(written1.idle_grace_s, 600);
  assert.equal(written1.project_only, undefined);
  assert.equal(written1.run.length, 2);
  assert.equal(written1.run[0].agent, 'agy');

  // Shipped and project files were never modified.
  assert.equal(fs.readFileSync(join(bundled, 'roles', 'imp.json'), 'utf8'), shippedImpBefore);
  assert.equal(fs.readFileSync(projImpPath, 'utf8'), projImpText);

  // 2. Existing $HUD_HOME/roles/imp.json with extra fields keeps every other field.
  fs.writeFileSync(
    writtenPath,
    JSON.stringify({ ...written1, idle_grace_s: 1200, custom_note: 'keep-me', nested: { a: 1 } }, null, 2)
  );
  writeRolePlaces(
    s.hud,
    'imp',
    [{ harness: 'cli', agent: 'claude', model: 'sonnet', thinking: 'medium' }],
    bundled
  );
  const written2 = JSON.parse(fs.readFileSync(writtenPath, 'utf8'));
  assert.equal(written2.idle_grace_s, 1200);
  assert.equal(written2.custom_note, 'keep-me');
  assert.deepEqual(written2.nested, { a: 1 });
  assert.deepEqual(written2.run, [{ harness: 'cli', agent: 'claude', model: 'sonnet', thinking: 'medium' }]);

  // 3. hud_roster (through real MCP) sees the written place when no project override hides it.
  const otherCwd = join(s.root, 'plain-cwd');
  fs.mkdirSync(otherCwd);
  const child = spawn(process.execPath, [mcpEntry], {
    cwd: otherCwd,
    env: { ...process.env, HUD_MCP_SURFACE: 'roles', HUD_HOME: s.hud, PATH: s.bin },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.stdin.end();
    await once(child, 'exit');
  });
  const reply = new Promise((done) => {
    createInterface({ input: child.stdout }).once('line', (line) => done(JSON.parse(line)));
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hud_roster', arguments: {} } }) + '\n');
  const res = await reply;
  const roster = JSON.parse(res.result.content[0].text);
  const imp = roster.roles.find((r) => r.role === 'imp');
  assert.equal(imp.harness, 'cli');
  assert.equal(imp.agent, 'claude');
  assert.equal(imp.model, 'sonnet');
  assert.equal(imp.thinking, 'medium');
  assert.equal(imp.source_file, writtenPath);
});

test('writeRolePlaces refuses symlinks, non-files, bad role names, and invalid run lists', (t) => {
  const s = makeSandbox(t);
  const rolesDir = join(s.hud, 'roles');
  fs.mkdirSync(rolesDir, { recursive: true });
  const decoy = join(s.root, 'decoy.json');
  fs.writeFileSync(decoy, '{"role":"imp","can_continue":true}');

  // Symlink target (real target and dangling).
  const linkPath = join(rolesDir, 'imp.json');
  fs.symlinkSync(decoy, linkPath);
  assert.throws(() => writeRolePlaces(s.hud, 'imp', [{ harness: 'cli', agent: 'agy' }], bundled), /symlink/);
  assert.equal(fs.readFileSync(decoy, 'utf8'), '{"role":"imp","can_continue":true}');
  fs.unlinkSync(linkPath);

  fs.symlinkSync(join(s.root, 'missing.json'), linkPath);
  assert.throws(() => writeRolePlaces(s.hud, 'imp', [{ harness: 'cli', agent: 'agy' }], bundled), /symlink/);
  fs.unlinkSync(linkPath);

  // Non-file target (directory).
  fs.mkdirSync(linkPath);
  assert.throws(() => writeRolePlaces(s.hud, 'imp', [{ harness: 'cli', agent: 'agy' }], bundled), /non-file/);
  fs.rmdirSync(linkPath);

  // Symlink roles directory.
  fs.rmdirSync(rolesDir);
  const realDir = join(s.root, 'real-roles');
  fs.mkdirSync(realDir);
  fs.symlinkSync(realDir, rolesDir);
  assert.throws(() => writeRolePlaces(s.hud, 'imp', [{ harness: 'cli', agent: 'agy' }], bundled), /symlink/);
  fs.unlinkSync(rolesDir);

  // Bad role names and invalid run arrays.
  for (const badRole of ['', '.', '..', '../imp', 'a/b']) {
    assert.throws(() => writeRolePlaces(s.hud, badRole, [{ harness: 'cli', agent: 'agy' }], bundled), /invalid role/);
  }
  assert.throws(() => writeRolePlaces(s.hud, 'imp', [], bundled), /non-empty/);
  assert.throws(() => writeRolePlaces(s.hud, 'imp', [{ harness: 'cli' }], bundled), /invalid role places/);
});

test('clearExhausted removes the mark, keeps other marks, makes the place available again, and refuses symlinks', (t) => {
  const s = makeSandbox(t);
  const now = Date.parse('2026-11-14T10:00:00Z');
  assert.equal(clearExhausted(s.hud, 'pi:gpt-6.1-sol', now), false);
  assert.equal(fs.existsSync(join(s.hud, 'exhausted.json')), false);

  writeRolePlaces(
    s.hud,
    'imp',
    [
      { harness: 'pi', pi_role: 'implementer', split: false, model: 'openai/gpt-6.1-sol' },
      { harness: 'cli', agent: 'agy', model: 'gemini-4-hydrogen-high' },
    ],
    bundled
  );
  const piKey = placeKey({ harness: 'pi', model: 'openai/gpt-6.1-sol' });
  const agyKey = placeKey({ harness: 'cli', agent: 'agy', model: 'gemini-4-hydrogen-high' });
  markExhausted(s.hud, piKey, 'HTTP 429 rate limit', now);
  markExhausted(s.hud, agyKey, 'quota exceeded', now);

  const reg = roleRegistry(s.hud, s.cwd, s.env, undefined, undefined, bundled);
  const impBefore = reg.assignment(reg.roles().get('imp'), now + 1000);
  assert.equal(impBefore.available, false);
  assert.equal(impBefore.exhausted.length, 2);

  // Clear only piKey -> imp becomes available on pi again; agyKey remains marked.
  assert.equal(clearExhausted(s.hud, piKey, now + 1000), true);
  assert.equal(clearExhausted(s.hud, piKey, now + 1000), false);
  assert.equal(fs.statSync(join(s.hud, 'exhausted.json')).mode & 0o777, 0o600);

  const marks = readExhausted(s.hud, now + 1000);
  assert.equal(marks.has(piKey), false);
  assert.equal(marks.has(agyKey), true);

  const impAfter = reg.assignment(reg.roles().get('imp'), now + 1000);
  assert.equal(impAfter.available, true);
  assert.equal(impAfter.harness, 'pi');
  assert.equal(impAfter.model, 'openai/gpt-6.1-sol');
  assert.equal(impAfter.exhausted.length, 1);
  assert.equal(impAfter.exhausted[0].key, agyKey);

  // Refuse symlink on exhausted.json.
  const exPath = join(s.hud, 'exhausted.json');
  fs.unlinkSync(exPath);
  fs.symlinkSync(join(s.root, 'nope.json'), exPath);
  assert.throws(() => clearExhausted(s.hud, agyKey, now + 1000), /symlink/);
});
