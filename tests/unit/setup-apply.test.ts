// Synthetic HOME, HUD_HOME and project only. Apply and remove must not touch anything else.
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
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hud-apply-')));
  const home = join(root, 'home');
  const hud = join(root, 'hud');
  const project = join(root, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(hud, { mode: 0o700 });
  fs.mkdirSync(project);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let stdout = '';
  let stderr = '';
  const io = {
    env: { HOME: home, HUD_HOME: hud, PATH: '' } as NodeJS.ProcessEnv,
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

function skill(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, 'SKILL.md'), '# skill\n');
  return dir;
}

function writePlan(dir: string, body: unknown) {
  const path = join(dir, `plan-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
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

function mode(path: string) {
  return fs.statSync(path).mode & 0o777;
}

function read(path: string) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

test('apply writes the plan, is idempotent, and detect and roster show it', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(join(f.hud, 'roles'), { recursive: true });
  fs.writeFileSync(
    join(f.hud, 'roles', 'grok-imp.json'),
    JSON.stringify({ role: 'grok-imp', harness: 'cli', agent: 'grok', can_continue: true })
  );
  gitInit(f.project);
  const nested = join(f.project, 'nested');
  fs.mkdirSync(nested);
  const tickets = skill(join(f.root, 'skills', 'to-tickets'));
  const plan = writePlan(f.root, {
    version: 1,
    roles: ['imp', 'reviewer', 'sonic', 'frontend', 'grok-imp'],
    pi_roles: {
      frontend: { from: 'imp', model: 'anthropic/opus', thinking: 'high', skills: ['to-tickets'] },
      imp: { skills: ['to-tickets'] },
    },
    skills: { 'to-tickets': tickets },
    agents: { frontend: 'Markdown worker prompt...\n' },
    convention: 'keep',
  });
  const homeBefore = tree(f.home);
  const code = await main(['setup', '--apply', plan, '--cwd', nested], f.io);
  assert.equal(code, 0, f.err());
  assert.equal(
    f.out(),
    [
      'wrote .hud/agents/frontend.md',
      'wrote .hud/project.json',
      'wrote .hud/roles/frontend.json',
      'wrote .hud/roles/imp.json',
      'linked .hud/skills/to-tickets',
      'registered',
      '',
    ].join('\n')
  );
  assert.equal(tree(f.home), homeBefore);
  assert.equal(fs.existsSync(join(nested, '.hud')), false);
  assert.equal(fs.existsSync(join(f.project, '.hud', 'hud-convention.md')), false);
  assert.equal(fs.existsSync(join(f.project, '.hud', 'roles', 'reviewer.json')), false);
  assert.equal(fs.existsSync(join(f.project, '.hud', 'roles', 'grok-imp.json')), false);
  for (const dir of ['.hud', '.hud/roles', '.hud/skills', '.hud/agents'])
    assert.equal(mode(join(f.project, dir)), 0o755);
  for (const file of [
    '.hud/project.json',
    '.hud/roles/frontend.json',
    '.hud/roles/imp.json',
    '.hud/agents/frontend.md',
  ])
    assert.equal(mode(join(f.project, file)), 0o644);
  assert.deepEqual(read(join(f.project, '.hud/project.json')), {
    version: 1,
    roles: ['imp', 'reviewer', 'sonic', 'frontend', 'grok-imp'],
    links: ['to-tickets'],
    role_files: ['frontend', 'imp'],
    agents: ['frontend'],
    convention: false,
  });
  assert.deepEqual(read(join(f.project, '.hud/roles/frontend.json')), {
    role: 'frontend',
    harness: 'pi',
    pi_role: 'implementer',
    split: false,
    can_continue: true,
    model: 'anthropic/opus',
    thinking: 'high',
    skills: ['to-tickets'],
  });
  assert.deepEqual(read(join(f.project, '.hud/roles/imp.json')).skills, ['to-tickets']);
  assert.equal(fs.readFileSync(join(f.project, '.hud/agents/frontend.md'), 'utf8'), 'Markdown worker prompt...\n');
  const link = join(f.project, '.hud/skills/to-tickets');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(link), tickets);
  const projects = read(join(f.hud, 'projects.json'));
  assert.equal(projects.version, 1);
  assert.equal(projects.projects.length, 1);
  assert.equal(projects.projects[0].root, fs.realpathSync(f.project));
  assert.match(projects.projects[0].registered_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  f.reset();
  const before = tree(f.project);
  const hudBefore = tree(f.hud);
  assert.equal(await main(['setup', '--cwd', nested, '--apply', plan], f.io), 0, f.err());
  assert.equal(f.out(), 'no changes\n');
  assert.equal(tree(f.project), before);
  assert.equal(tree(f.hud), hudBefore);

  f.reset();
  assert.equal(await main(['setup', '--detect', '--cwd', nested], f.io), 0, f.err());
  const doc = JSON.parse(f.out());
  assert.equal(doc.project.registered, true);
  assert.equal(doc.project.root, fs.realpathSync(f.project));
  assert.deepEqual(doc.enabled_roles, ['frontend', 'grok-imp', 'imp', 'reviewer', 'sonic']);
  assert.deepEqual(
    doc.project_roles.map((role: { role: string }) => role.role),
    ['frontend', 'imp']
  );
  assert.equal(doc.project_roles.find((role: { role: string }) => role.role === 'frontend').model, 'anthropic/opus');
  assert.deepEqual(doc.worker_skills, { frontend: ['to-tickets'], imp: ['to-tickets'] });
  assert.deepEqual(doc.skill_links, [{ name: 'to-tickets', target: tickets, broken: false }]);
  const registry = roleRegistry(f.hud, nested, f.io.env, undefined, undefined, bundled);
  assert.deepEqual([...registry.roles().keys()].sort(), doc.enabled_roles);
  const frontend = registry.roles().get('frontend');
  assert.equal(frontend?.harness, 'pi');
  assert.equal(frontend?.model, 'anthropic/opus');
  assert.deepEqual(frontend?.skills, ['to-tickets']);
  assert.equal(registry.assignment(frontend!).model, 'anthropic/opus');
  assert.equal(registry.roles().has('grok-imp'), true);
  assert.equal(registry.roles().has('oracle'), false);
  assert.equal(tree(f.project), before);
});

test('plan change removes owned links, role files and agents, and copy-default is kept', async (t) => {
  const f = fixture(t);
  gitInit(f.project);
  const one = skill(join(f.root, 'one'));
  const two = skill(join(f.root, 'two'));
  const moved = skill(join(f.root, 'moved'));
  const first = writePlan(f.root, {
    version: 1,
    roles: ['imp', 'frontend'],
    pi_roles: {
      frontend: { from: 'imp', model: 'a', skills: ['one'] },
      imp: { model: 'changed', skills: ['one'] },
    },
    skills: { one, two },
    agents: { frontend: 'front', imp: 'imp prompt' },
    convention: 'copy-default',
  });
  assert.equal(await main(['setup', '--apply', first, '--cwd', f.project], f.io), 0, f.err());
  assert.equal(
    fs.readFileSync(join(f.project, '.hud/hud-convention.md'), 'utf8'),
    fs.readFileSync(join(bundled, 'hud-convention.md'), 'utf8')
  );
  assert.equal(read(join(f.project, '.hud/project.json')).convention, true);
  f.reset();
  const second = writePlan(f.root, {
    version: 1,
    roles: ['imp', 'reviewer'],
    pi_roles: { imp: {} },
    skills: { one: moved },
    convention: 'keep',
  });
  assert.equal(await main(['setup', '--apply', second, '--cwd', f.project], f.io), 0, f.err());
  assert.equal(
    f.out(),
    [
      'removed .hud/agents/frontend.md',
      'removed .hud/agents/imp.md',
      'removed .hud/roles/frontend.json',
      'removed .hud/roles/imp.json',
      'removed .hud/skills/two',
      'wrote .hud/project.json',
      'linked .hud/skills/one',
      '',
    ].join('\n')
  );
  assert.equal(fs.existsSync(join(f.project, '.hud/roles/imp.json')), false);
  assert.equal(fs.existsSync(join(f.project, '.hud/roles/frontend.json')), false);
  assert.equal(fs.existsSync(join(f.project, '.hud/agents/frontend.md')), false);
  assert.equal(fs.readlinkSync(join(f.project, '.hud/skills/one')), moved);
  assert.equal(fs.existsSync(join(f.project, '.hud/skills/two')), false);
  assert.equal(fs.existsSync(join(f.project, '.hud/hud-convention.md')), true);
  assert.deepEqual(read(join(f.project, '.hud/project.json')), {
    version: 1,
    roles: ['imp', 'reviewer'],
    links: ['one'],
    role_files: [],
    agents: [],
    convention: true,
  });
  const shipped = fs.readFileSync(join(bundled, 'hud-convention.md'));
  f.reset();
  const before = tree(f.project);
  assert.equal(await main(['setup', '--apply', second, '--cwd', f.project], f.io), 0, f.err());
  assert.equal(f.out(), 'no changes\n');
  assert.equal(tree(f.project), before);
  assert.equal(fs.readFileSync(join(f.project, '.hud/hud-convention.md')).equals(shipped), true);
});

test('foreign files and links are skipped and never replaced', async (t) => {
  const f = fixture(t);
  const tickets = skill(join(f.root, 'skills', 'to-tickets'));
  fs.mkdirSync(join(f.project, '.hud/roles'), { recursive: true });
  fs.mkdirSync(join(f.project, '.hud/skills'), { recursive: true });
  fs.mkdirSync(join(f.project, '.hud/agents'), { recursive: true });
  fs.writeFileSync(join(f.project, '.hud/roles/frontend.json'), '{"foreign":true}\n');
  fs.writeFileSync(join(f.project, '.hud/roles/reviewer.json'), '{"foreign":"reviewer"}\n');
  fs.writeFileSync(join(f.project, '.hud/roles/custom.json'), '{"foreign":"custom"}\n');
  fs.writeFileSync(join(f.project, '.hud/skills/to-tickets'), 'not a link');
  fs.writeFileSync(join(f.project, '.hud/agents/frontend.md'), 'foreign prompt');
  const plan = writePlan(f.root, {
    version: 1,
    roles: ['imp', 'frontend', 'reviewer'],
    pi_roles: {
      frontend: { from: 'imp', model: 'x' },
      imp: { skills: ['to-tickets'] },
      reviewer: {},
    },
    skills: { 'to-tickets': tickets },
    agents: { frontend: 'prompt' },
  });
  assert.equal(await main(['setup', '--apply', plan, '--cwd', f.project], f.io), 1, f.err());
  assert.match(f.out(), /skipped \(exists\) \.hud\/roles\/frontend\.json/);
  assert.match(f.out(), /skipped \(exists\) \.hud\/roles\/reviewer\.json/);
  assert.match(f.out(), /skipped \(exists\) \.hud\/skills\/to-tickets/);
  assert.match(f.out(), /skipped \(exists\) \.hud\/agents\/frontend\.md/);
  assert.equal(f.out().includes('custom.json'), false);
  assert.equal(fs.readFileSync(join(f.project, '.hud/roles/frontend.json'), 'utf8'), '{"foreign":true}\n');
  assert.equal(fs.readFileSync(join(f.project, '.hud/roles/reviewer.json'), 'utf8'), '{"foreign":"reviewer"}\n');
  assert.equal(fs.readFileSync(join(f.project, '.hud/roles/custom.json'), 'utf8'), '{"foreign":"custom"}\n');
  assert.equal(fs.readFileSync(join(f.project, '.hud/skills/to-tickets'), 'utf8'), 'not a link');
  assert.equal(fs.readFileSync(join(f.project, '.hud/agents/frontend.md'), 'utf8'), 'foreign prompt');
  const ledger = read(join(f.project, '.hud/project.json'));
  assert.deepEqual(ledger.role_files, ['imp']);
  assert.deepEqual(ledger.links, []);
  assert.deepEqual(ledger.agents, []);
  assert.equal(read(join(f.hud, 'projects.json')).projects[0].root, fs.realpathSync(f.project));
  f.reset();
  const before = [tree(f.project), tree(f.hud)].join('\n---\n');
  assert.equal(await main(['setup', '--apply', plan, '--cwd', f.project], f.io), 1, f.err());
  assert.equal([tree(f.project), tree(f.hud)].join('\n---\n'), before);
  assert.equal(f.out().includes('wrote '), false);
  assert.match(f.out(), /skipped \(exists\)/);
});

test('invalid plans write nothing', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(join(f.hud, 'roles'), { recursive: true });
  fs.writeFileSync(
    join(f.hud, 'roles', 'grok-imp.json'),
    JSON.stringify({ role: 'grok-imp', harness: 'cli', agent: 'grok', can_continue: true })
  );
  const tickets = skill(join(f.root, 'skills', 'to-tickets'));
  const empty = join(f.root, 'empty-dir');
  fs.mkdirSync(empty);
  const before = [f.home, f.hud, f.project].map(tree).join('\n---\n');
  const cases: [string, unknown][] = [
    ['unreadable', undefined],
    ['not json', '{'],
    ['not an object', []],
    ['unknown field extra', { version: 1, roles: ['imp'], extra: 1 }],
    ['version', { version: 2, roles: ['imp'] }],
    ['roles', { version: 1 }],
    ['roles', { version: 1, roles: 'imp' }],
    ['roles', { version: 1, roles: [1] }],
    ['roles', { version: 1, roles: [''] }],
    ['role nope', { version: 1, roles: ['nope'] }],
    ['pi_roles', { version: 1, roles: ['imp'], pi_roles: [] }],
    ['pi_roles.oracle is not pi', { version: 1, roles: ['oracle'], pi_roles: { oracle: { from: 'imp' } } }],
    ['pi_roles.grok-imp is not pi', { version: 1, roles: ['grok-imp'], pi_roles: { 'grok-imp': {} } }],
    ['pi_roles.frontend.from', { version: 1, roles: ['frontend'], pi_roles: { frontend: {} } }],
    ['pi_roles.frontend.from', { version: 1, roles: ['frontend'], pi_roles: { frontend: { from: 'oracle' } } }],
    ['pi_roles.frontend.from', { version: 1, roles: ['frontend'], pi_roles: { frontend: { from: 'grok-imp' } } }],
    ['pi_roles.frontend.from', { version: 1, roles: ['frontend'], pi_roles: { frontend: { from: 'missing' } } }],
    ['pi_roles.imp.extra', { version: 1, roles: ['imp'], pi_roles: { imp: { extra: 1 } } }],
    ['pi_roles.imp.split', { version: 1, roles: ['imp'], pi_roles: { imp: { split: 'yes' } } }],
    ['pi_roles.imp.can_continue', { version: 1, roles: ['imp'], pi_roles: { imp: { can_continue: 'yes' } } }],
    ['pi_roles.imp.model', { version: 1, roles: ['imp'], pi_roles: { imp: { model: 1 } } }],
    ['pi_roles.imp.thinking', { version: 1, roles: ['imp'], pi_roles: { imp: { thinking: 1 } } }],
    ['pi_roles.imp.pi_role', { version: 1, roles: ['imp'], pi_roles: { imp: { pi_role: '' } } }],
    ['pi_roles.imp.skills', { version: 1, roles: ['imp'], pi_roles: { imp: { skills: ['missing'] } } }],
    ['pi_roles.imp.skills', { version: 1, roles: ['imp'], pi_roles: { imp: { skills: 'to-tickets' } } }],
    ['pi_roles...', { version: 1, roles: ['imp'], pi_roles: { '..': { from: 'imp' } } }],
    ['skills', { version: 1, roles: ['imp'], skills: [] }],
    ['skills.bad name', { version: 1, roles: ['imp'], skills: { 'bad name': tickets } }],
    ['skills...', { version: 1, roles: ['imp'], skills: { '..': tickets } }],
    ['skills.ok', { version: 1, roles: ['imp'], skills: { ok: 'relative' } }],
    ['skills.ok', { version: 1, roles: ['imp'], skills: { ok: empty } }],
    ['skills.ok', { version: 1, roles: ['imp'], skills: { ok: join(f.root, 'missing-skill') } }],
    ['agents', { version: 1, roles: ['imp'], agents: [] }],
    ['agents.grok-imp', { version: 1, roles: ['grok-imp'], agents: { 'grok-imp': 'x' } }],
    ['agents.nope', { version: 1, roles: ['imp'], agents: { nope: 'x' } }],
    ['agents.imp', { version: 1, roles: ['imp'], agents: { imp: 1 } }],
    ['agents.imp too long', { version: 1, roles: ['imp'], agents: { imp: 'x'.repeat(65537) } }],
    ['convention', { version: 1, roles: ['imp'], convention: 'nope' }],
  ];
  for (const [reason, body] of cases) {
    f.reset();
    const path = body === undefined ? join(f.root, 'missing-plan.json') : writePlan(f.root, body);
    assert.equal(await main(['setup', '--apply', path, '--cwd', f.project], f.io), 2, reason);
    assert.equal(f.err(), `invalid plan: ${reason}\n`, reason);
    assert.equal(f.out(), '', reason);
    assert.equal([f.home, f.hud, f.project].map(tree).join('\n---\n'), before, reason);
  }
  f.reset();
  const exact = writePlan(f.root, { version: 1, roles: ['imp'], agents: { imp: 'x'.repeat(65536) } });
  assert.equal(await main(['setup', '--apply', exact, '--cwd', f.project], f.io), 0, f.err());
  assert.equal(fs.readFileSync(join(f.project, '.hud/agents/imp.md'), 'utf8').length, 65536);
});

test('remove drops only the registration and leaves .hud', async (t) => {
  const f = fixture(t);
  gitInit(f.project);
  fs.mkdirSync(join(f.project, 'nested'));
  const other = join(f.root, 'other');
  fs.mkdirSync(other);
  fs.writeFileSync(
    join(f.hud, 'projects.json'),
    JSON.stringify({ version: 1, note: 'keep', projects: [{ root: other, registered_at: '2026-11-13T00:00:00.000Z' }] })
  );
  const plan = writePlan(f.root, {
    version: 1,
    roles: ['imp', 'frontend'],
    pi_roles: { frontend: { from: 'imp', model: 'anthropic/opus' } },
    skills: {},
  });
  assert.equal(await main(['setup', '--apply', plan, '--cwd', f.project], f.io), 0, f.err());
  const top = fs.realpathSync(f.project);
  const saved = tree(f.project);
  f.reset();
  assert.equal(await main(['setup', '--remove', '--cwd', join(f.project, 'nested')], f.io), 0, f.err());
  assert.equal(f.out(), 'unregistered\n');
  assert.equal(f.err(), '');
  assert.equal(tree(f.project), saved);
  const projects = read(join(f.hud, 'projects.json'));
  assert.equal(projects.note, 'keep');
  assert.deepEqual(projects.projects, [{ root: other, registered_at: '2026-11-13T00:00:00.000Z' }]);
  f.reset();
  assert.equal(await main(['setup', '--detect', '--cwd', f.project], f.io), 0, f.err());
  const doc = JSON.parse(f.out());
  assert.equal(doc.project.registered, false);
  assert.equal(doc.project_roles.length, 0);
  assert.equal(JSON.stringify(doc).includes('frontend'), false);
  const registry = roleRegistry(f.hud, f.project, f.io.env, undefined, undefined, bundled);
  assert.equal(registry.project().registered, false);
  assert.equal(registry.projectConfigIgnored(), top);
  assert.equal(registry.roles().has('frontend'), false);
  f.reset();
  const hudBefore = tree(f.hud);
  assert.equal(await main(['setup', '--remove', '--cwd', f.project], f.io), 0, f.err());
  assert.equal(f.out(), 'not registered\n');
  assert.equal(tree(f.hud), hudBefore);
  assert.equal(tree(f.project), saved);
});

test('a symlinked .hud or target parent is refused and nothing is written', async (t) => {
  const f = fixture(t);
  const outside = join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(join(outside, 'marker'), 'keep');
  const tickets = skill(join(f.root, 'skills', 'to-tickets'));
  const plan = writePlan(f.root, {
    version: 1,
    roles: ['frontend'],
    pi_roles: { frontend: { from: 'imp', model: 'anthropic/opus', skills: ['to-tickets'] } },
    skills: { 'to-tickets': tickets },
    agents: { frontend: 'prompt' },
    convention: 'copy-default',
  });
  fs.symlinkSync(outside, join(f.project, '.hud'));
  const before = [f.home, f.hud, outside].map(tree).join('\n---\n');
  assert.equal(await main(['setup', '--apply', plan, '--cwd', f.project], f.io), 2, f.err());
  assert.equal(f.err(), 'refusing: .hud is a symlink\n');
  assert.equal(f.out(), '');
  assert.equal([f.home, f.hud, outside].map(tree).join('\n---\n'), before);
  assert.equal(fs.readlinkSync(join(f.project, '.hud')), outside);

  fs.unlinkSync(join(f.project, '.hud'));
  fs.mkdirSync(join(f.project, '.hud'));
  fs.symlinkSync(outside, join(f.project, '.hud/roles'));
  f.reset();
  assert.equal(await main(['setup', '--apply', plan, '--cwd', f.project], f.io), 2, f.err());
  assert.equal(f.err(), 'refusing: .hud/roles is a symlink\n');
  assert.equal(f.out(), '');
  assert.equal(fs.existsSync(join(f.project, '.hud/project.json')), false);
  assert.equal(fs.existsSync(join(f.hud, 'projects.json')), false);
  assert.equal(fs.readFileSync(join(outside, 'marker'), 'utf8'), 'keep');
  assert.equal([f.home, f.hud, outside].map(tree).join('\n---\n'), before);
});

test('a project role copies the winning reference file, including a HUD_HOME override', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(join(f.hud, 'roles'), { recursive: true });
  fs.writeFileSync(
    join(f.hud, 'roles/imp.json'),
    JSON.stringify({
      role: 'imp',
      harness: 'pi',
      pi_role: 'implementer',
      split: true,
      can_continue: true,
      model: 'home-model',
    })
  );
  const plan = writePlan(f.root, {
    version: 1,
    roles: ['frontend', 'imp'],
    pi_roles: { frontend: { from: 'imp' }, imp: {} },
  });
  assert.equal(await main(['setup', '--apply', plan, '--cwd', f.project], f.io), 0, f.err());
  assert.equal(fs.existsSync(join(f.project, '.hud/roles/imp.json')), false);
  assert.deepEqual(read(join(f.project, '.hud/roles/frontend.json')), {
    role: 'frontend',
    harness: 'pi',
    pi_role: 'implementer',
    split: true,
    can_continue: true,
    model: 'home-model',
  });
  const registry = roleRegistry(f.hud, f.project, f.io.env, undefined, undefined, bundled);
  assert.equal(registry.roles().get('frontend')?.model, 'home-model');
  assert.equal(registry.roles().get('imp')?.model, 'home-model');
  assert.equal(registry.roles().get('imp')?.source_file, join(f.hud, 'roles/imp.json'));
});

test('apply refuses a projects.json that is not version 1 and a missing plan argument', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(join(f.hud, 'projects.json'), '{}\n');
  const plan = writePlan(f.root, { version: 1, roles: ['imp'] });
  const before = [f.home, f.hud, f.project].map(tree).join('\n---\n');
  assert.equal(await main(['setup', '--apply', plan, '--cwd', f.project], f.io), 2);
  assert.equal(f.err(), 'refusing: projects.json is not version 1\n');
  assert.equal([f.home, f.hud, f.project].map(tree).join('\n---\n'), before);
  f.reset();
  assert.equal(await main(['setup', '--apply', '--cwd', f.project], f.io), 2);
  assert.match(f.err(), /usage: hud setup --detect/);
  assert.equal([f.home, f.hud, f.project].map(tree).join('\n---\n'), before);
});
