// Synthetic HOME, HUD_HOME and project only. Detect must not write.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { main } from '../../src/cli/hud.js';
import { roleRegistry } from '../../src/roles/roster.js';

const bundled = join(process.cwd(), 'packages/hud-mcp');

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hud-setup-')));
  const home = join(root, 'home');
  const hud = join(root, 'hud');
  const project = join(root, 'project');
  const bin = join(root, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(hud, { mode: 0o700 });
  fs.mkdirSync(project);
  fs.mkdirSync(bin);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let stdout = '';
  let stderr = '';
  const io = {
    env: { HOME: home, HUD_HOME: hud, PATH: bin } as NodeJS.ProcessEnv,
    stdout: (text: string) => {
      stdout += text;
    },
    stderr: (text: string) => {
      stderr += text;
    },
  };
  return {
    root,
    home,
    hud,
    project,
    bin,
    io,
    out: () => stdout,
    err: () => stderr,
    reset: () => {
      stdout = '';
      stderr = '';
    },
  };
}

function gitInit(dir: string) {
  const result = spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function piRole(role: string, extra: Record<string, unknown> = {}) {
  return { role, harness: 'pi', pi_role: 'implementer', split: false, can_continue: true, ...extra };
}

function register(hud: string, project: string) {
  const top = fs.realpathSync(project);
  fs.writeFileSync(
    join(hud, 'projects.json'),
    JSON.stringify({ version: 1, projects: [{ root: top, registered_at: '2026-11-13T00:00:00.000Z' }] })
  );
  return top;
}

function skill(root: string, dir: string, body: string) {
  const path = join(root, dir);
  fs.mkdirSync(path, { recursive: true });
  fs.writeFileSync(join(path, 'SKILL.md'), body);
  return path;
}

function tree(dir: string): string {
  if (!fs.existsSync(dir)) return `missing:${dir}`;
  const parts: string[] = [];
  const walk = (path: string) => {
    for (const name of fs.readdirSync(path).sort()) {
      const file = join(path, name);
      const stat = fs.lstatSync(file);
      parts.push(file, String(stat.mode), String(stat.mtimeMs));
      if (stat.isSymbolicLink()) parts.push(fs.readlinkSync(file));
      else if (stat.isDirectory()) walk(file);
      else parts.push(fs.readFileSync(file).toString('hex'));
    }
  };
  walk(dir);
  return parts.join('\n');
}

async function detect(f: ReturnType<typeof fixture>, cwd: string) {
  const before = [f.home, f.hud, f.project].map(tree);
  const code = await main(['setup', '--detect', '--cwd', cwd], f.io);
  assert.equal([f.home, f.hud, f.project].map(tree).join('\n---\n'), before.join('\n---\n'));
  assert.equal(code, 0, f.err());
  const text = f.out();
  const doc = JSON.parse(text);
  assert.equal(text, JSON.stringify(doc, null, 2) + '\n');
  assert.deepEqual(Object.keys(doc), [
    'project',
    'pi',
    'reference_roles',
    'project_roles',
    'enabled_roles',
    'invalid',
    'skills',
    'worker_skills',
    'skill_links',
  ]);
  return doc;
}

test('unregistered detect ignores project files and uses default skill roots', async (t) => {
  const f = fixture(t);
  gitInit(f.project);
  const sub = join(f.project, 'nested');
  fs.mkdirSync(sub);
  fs.mkdirSync(join(f.hud, 'roles'), { recursive: true });
  fs.writeFileSync(join(f.hud, 'roles', 'extra.json'), JSON.stringify(piRole('extra', { model: 'home-model' })));
  fs.writeFileSync(
    join(f.hud, 'roles', 'cli-extra.json'),
    JSON.stringify({ role: 'cli-extra', harness: 'cli', agent: 'grok', can_continue: true })
  );
  fs.writeFileSync(join(f.hud, 'roles', 'bad.json'), '{');
  fs.writeFileSync(join(f.hud, 'setup.json'), '{');
  fs.mkdirSync(join(f.project, '.hud/roles'), { recursive: true });
  fs.writeFileSync(
    join(f.project, '.hud/roles', 'secret.json'),
    JSON.stringify(piRole('secret', { skills: ['hidden'] }))
  );
  fs.mkdirSync(join(f.project, '.hud/skills'), { recursive: true });
  fs.symlinkSync(join(f.root, 'missing-skill'), join(f.project, '.hud/skills', 'gone'));
  skill(f.home, '.pi/agent/skills/plain', '# plain\n');
  skill(f.home, '.claude/skills/zeta', '---\nname: from-claude\n---\n');
  skill(f.home, '.agents/skills/mid', '---\nname: "quoted"\n---\n');
  fs.mkdirSync(join(f.home, '.pi/agent/skills/plain/nested'));
  fs.writeFileSync(join(f.home, '.pi/agent/skills/plain/nested/SKILL.md'), '---\nname: nested\n---\n');
  fs.symlinkSync(join(f.root, 'missing-dir'), join(f.home, '.pi/agent/skills', 'broken'));
  const missingHud = join(f.root, 'missing-hud');

  const doc = await detect(f, sub);
  const top = fs.realpathSync(f.project);
  assert.equal(doc.project.root, top);
  assert.equal(doc.project.registered, false);
  assert.equal(doc.project.hud_dir, join(top, '.hud'));
  assert.equal(doc.project.hud_dir_exists, true);
  assert.deepEqual(doc.pi, { installed: false, pi_role: null });
  assert.deepEqual(doc.project_roles, []);
  assert.deepEqual(doc.worker_skills, {});
  assert.deepEqual(doc.skill_links, []);
  assert.equal(JSON.stringify(doc).includes('secret'), false);
  assert.equal(JSON.stringify(doc).includes('gone'), false);
  const extra = doc.reference_roles.find((role: { role: string }) => role.role === 'extra');
  assert.equal(extra.source, '$HUD_HOME/roles/extra.json');
  assert.equal(extra.model, 'home-model');
  assert.equal(extra.thinking, null);
  const imp = doc.reference_roles.find((role: { role: string }) => role.role === 'imp');
  assert.equal(imp.source, 'shipped');
  assert.equal(imp.harness, 'pi');
  assert.equal(imp.pi_role, 'implementer');
  assert.equal(imp.model, null);
  assert.deepEqual(Object.keys(imp), ['role', 'harness', 'pi_role', 'model', 'thinking', 'source']);
  const cliExtra = doc.reference_roles.find((role: { role: string }) => role.role === 'cli-extra');
  assert.equal(cliExtra.agent, 'grok');
  assert.equal(cliExtra.pi_role, undefined);
  const oracle = doc.reference_roles.find((role: { role: string }) => role.role === 'oracle');
  assert.equal(oracle.harness, 'cli');
  assert.equal(oracle.agent, 'claude');
  assert.equal(oracle.model, 'fable');
  assert.equal(oracle.pi_role, undefined);
  const pro = doc.reference_roles.find((role: { role: string }) => role.role === 'pro');
  assert.equal(pro.harness, 'bro');
  assert.equal(pro.pi_role, undefined);
  assert.deepEqual(
    doc.enabled_roles,
    [...roleRegistry(f.hud, sub, f.io.env, undefined, undefined, bundled).roles().keys()].sort()
  );
  assert.deepEqual(doc.invalid, [{ path: join(f.hud, 'roles', 'bad.json'), reason: 'unparseable JSON' }]);
  assert.deepEqual(doc.skills, [
    {
      name: 'from-claude',
      path: join(f.home, '.claude/skills/zeta'),
      root: join(f.home, '.claude/skills'),
      model_invocable: true,
    },
    {
      name: 'plain',
      path: join(f.home, '.pi/agent/skills/plain'),
      root: join(f.home, '.pi/agent/skills'),
      model_invocable: true,
    },
    {
      name: 'quoted',
      path: join(f.home, '.agents/skills/mid'),
      root: join(f.home, '.agents/skills'),
      model_invocable: true,
    },
  ]);
  f.reset();
  assert.equal(await main(['setup', '--cwd', sub, '--detect'], f.io), 0);
  assert.equal(f.out(), JSON.stringify(doc, null, 2) + '\n');
  f.reset();
  assert.equal(
    await main(['setup', '--detect', '--cwd', f.project], { ...f.io, env: { ...f.io.env, HUD_HOME: missingHud } }),
    0
  );
  assert.equal(fs.existsSync(missingHud), false);
});

test('registered detect reports project roles, custom skill roots, links and invalid files', async (t) => {
  const f = fixture(t);
  gitInit(f.project);
  const top = register(f.hud, f.project);
  fs.writeFileSync(join(f.bin, 'pi-role'), '#!/bin/sh\n');
  fs.chmodSync(join(f.bin, 'pi-role'), 0o755);
  fs.mkdirSync(join(f.hud, 'roles'), { recursive: true });
  fs.writeFileSync(join(f.hud, 'roles', 'extra.json'), JSON.stringify(piRole('extra', { model: 'home' })));
  fs.writeFileSync(join(f.hud, 'roles', 'bad-home.json'), 'null');
  fs.mkdirSync(join(f.project, '.hud/roles'), { recursive: true });
  fs.writeFileSync(
    join(f.project, '.hud/roles/imp.json'),
    JSON.stringify(piRole('imp', { model: 'project', thinking: 'low', skills: ['to-tickets', 'other'] }))
  );
  fs.writeFileSync(join(f.project, '.hud/roles/frontend.json'), JSON.stringify(piRole('frontend')));
  fs.writeFileSync(join(f.project, '.hud/roles/hidden.json'), JSON.stringify(piRole('hidden', { skills: ['kept'] })));
  fs.writeFileSync(
    join(f.project, '.hud/roles/local.json'),
    JSON.stringify({ role: 'local', harness: 'cli', agent: 'grok', can_continue: true, note: 'SECRET' })
  );
  fs.writeFileSync(join(f.project, '.hud/project.json'), JSON.stringify({ version: 1, roles: ['imp', 'frontend'] }));
  const skillDir = join(f.root, 'skills');
  const first = join(skillDir, 'one');
  const second = join(skillDir, 'two');
  const named = skill(first, 'dir-name', '---\nname: fancy\n---\nbody\n');
  const sharedA = skill(first, 'shared', '---\nname: shared\n---\n');
  const sharedB = skill(second, 'shared', '---\nname: shared\n---\n');
  const linked = join(f.root, 'linked-skill');
  skill(f.root, 'linked-skill', '# linked\n');
  fs.symlinkSync(linked, join(second, 'via-link'));
  fs.mkdirSync(join(first, 'note'));
  fs.writeFileSync(join(first, 'note', 'README.md'), 'not a skill');
  fs.writeFileSync(join(f.hud, 'setup.json'), JSON.stringify({ skill_roots: [first, '~/elsewhere', second] }));
  skill(f.home, '.pi/agent/skills/default-only', '# default\n');
  fs.mkdirSync(join(f.home, 'elsewhere/only-tilde'), { recursive: true });
  fs.writeFileSync(join(f.home, 'elsewhere/only-tilde/SKILL.md'), '---\nname: tilde\n---\n');
  const live = join(f.root, 'live-skill');
  fs.mkdirSync(live);
  fs.mkdirSync(join(f.project, '.hud/skills'), { recursive: true });
  fs.symlinkSync(live, join(f.project, '.hud/skills', 'live'));
  fs.symlinkSync(join(f.root, 'missing-skill'), join(f.project, '.hud/skills', 'gone'));
  fs.writeFileSync(join(f.project, '.hud/skills', 'file'), 'not a link');

  const sub = join(f.project, 'nested');
  fs.mkdirSync(sub);
  const doc = await detect(f, sub);
  assert.equal(doc.project.root, top);
  assert.equal(doc.project.registered, true);
  assert.equal(doc.project.hud_dir_exists, true);
  assert.deepEqual(doc.pi, { installed: true, pi_role: fs.realpathSync(join(f.bin, 'pi-role')) });
  assert.deepEqual(Object.keys(doc.pi), ['installed', 'pi_role']);
  const refImp = doc.reference_roles.find((role: { role: string }) => role.role === 'imp');
  assert.equal(refImp.source, 'shipped');
  assert.equal(refImp.model, null);
  assert.equal(
    doc.reference_roles.some((role: { role: string }) => role.role === 'frontend'),
    false
  );
  assert.deepEqual(
    doc.project_roles.map((role: { role: string; source: string }) => [role.role, role.source]),
    [
      ['frontend', '.hud/roles/frontend.json'],
      ['hidden', '.hud/roles/hidden.json'],
      ['imp', '.hud/roles/imp.json'],
    ]
  );
  assert.equal(doc.project_roles.find((role: { role: string }) => role.role === 'imp').model, 'project');
  assert.equal(doc.project_roles.find((role: { role: string }) => role.role === 'imp').thinking, 'low');
  assert.deepEqual(doc.enabled_roles, ['frontend', 'imp']);
  assert.deepEqual(doc.worker_skills, { hidden: ['kept'], imp: ['to-tickets', 'other'] });
  const registry = roleRegistry(f.hud, f.project, f.io.env, undefined, undefined, bundled);
  assert.deepEqual(doc.invalid, registry.invalid());
  assert.equal(
    doc.invalid.some((item: { path: string }) => item.path.endsWith('local.json')),
    true
  );
  assert.equal(
    doc.invalid.some((item: { path: string }) => item.path.endsWith('bad-home.json')),
    true
  );
  assert.equal(JSON.stringify(doc.invalid).includes('SECRET'), false);
  assert.deepEqual(doc.skills, [
    { name: 'fancy', path: named, root: first, model_invocable: true },
    { name: 'shared', path: sharedA, root: first, model_invocable: true },
    { name: 'shared', path: sharedB, root: second, model_invocable: true },
    {
      name: 'tilde',
      path: join(f.home, 'elsewhere/only-tilde'),
      root: join(f.home, 'elsewhere'),
      model_invocable: true,
    },
    { name: 'via-link', path: fs.realpathSync(linked), root: second, model_invocable: true },
  ]);
  assert.equal(
    doc.skills.some((item: { name: string }) => item.name === 'default-only'),
    false
  );
  assert.deepEqual(doc.skill_links, [
    { name: 'file', target: null, broken: true },
    { name: 'gone', target: join(f.root, 'missing-skill'), broken: true },
    { name: 'live', target: live, broken: false },
  ]);
  assert.deepEqual(doc.enabled_roles, [...registry.roles().keys()].sort());
});

test('detect marks skills that disable model invocation', async (t) => {
  const f = fixture(t);
  skill(f.home, '.pi/agent/skills/auto', '---\nname: auto\n---\n');
  skill(f.home, '.claude/skills/manual', '---\ndisable-model-invocation: true\nname: manual\n---\n');
  skill(f.home, '.agents/skills/quoted-off', '---\nname: quoted-off\ndisable-model-invocation: "true"\n---\n');
  skill(f.home, '.agents/skills/kept', '---\nname: kept\ndisable-model-invocation: false\n---\n');
  skill(f.home, '.pi/agent/skills/body-only', '# notes\ndisable-model-invocation: true\n');
  const doc = await detect(f, f.project);
  assert.deepEqual(
    doc.skills.map((item: { name: string; model_invocable: boolean }) => [item.name, item.model_invocable]),
    [
      ['auto', true],
      ['body-only', true],
      ['kept', true],
      ['manual', false],
      ['quoted-off', false],
    ]
  );
});

test('usage errors write nothing', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(join(f.hud, 'projects.json'), '{}\n');
  const before = [f.home, f.hud, f.project].map(tree).join('\n---\n');
  const unchanged = () => assert.equal([f.home, f.hud, f.project].map(tree).join('\n---\n'), before);
  assert.equal(await main(['setup'], f.io), 2);
  assert.match(f.err(), /usage: hud setup --detect \[--cwd DIR\]/);
  unchanged();
  f.reset();
  assert.equal(await main(['setup', '--detect', '--nope'], f.io), 2);
  assert.match(f.err(), /usage: hud setup --detect/);
  unchanged();
  f.reset();
  assert.equal(await main(['setup', '--cwd'], f.io), 2);
  unchanged();
  f.reset();
  assert.equal(await main(['setup', '--detect', '--cwd', join(f.root, 'missing')], f.io), 2);
  assert.match(f.err(), /not a directory/);
  unchanged();
  f.reset();
  const file = join(f.root, 'file');
  fs.writeFileSync(file, 'x');
  assert.equal(await main(['setup', '--detect', '--cwd', file], f.io), 2);
  assert.match(f.err(), /not a directory/);
  f.reset();
  assert.equal(await main(['setup', '--apply', join(f.root, 'plan.json'), '--cwd', f.project], f.io), 2);
  assert.equal(f.err(), 'invalid plan: unreadable\n');
  assert.equal(f.out(), '');
  unchanged();
  f.reset();
  assert.equal(await main(['setup', '--remove'], f.io), 0);
  assert.equal(f.out(), 'not registered\n');
  assert.equal(f.err(), '');
  unchanged();
  f.reset();
  assert.equal(await main(['setup', '--import-jev-env'], f.io), 2);
  assert.match(f.err(), /hud import/);
  unchanged();
  f.reset();
  assert.equal(await main(['--help'], f.io), 0);
  assert.match(f.out(), /hud setup --detect \[--cwd DIR\]/);
  f.reset();
  assert.equal(await main(['nope'], f.io), 2);
  assert.match(f.err(), /invalid_command:.*\bsetup\b/);
  unchanged();
});
