import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { projectRoot, registeredProject, sharedRoot } from '../../dist/roles/projects.js';
import { roleRegistry } from '../../dist/roles/roster.js';

function pi(role, extra = {}) {
  return { role, harness: 'pi', pi_role: 'implementer', split: false, can_continue: true, ...extra };
}
function layout() {
  const root = fs.mkdtempSync(join(tmpdir(), 'project-roles-'));
  const hud = join(root, 'hud');
  const bundled = join(root, 'bundled');
  const project = join(root, 'project');
  fs.mkdirSync(join(hud, 'roles'), { recursive: true });
  fs.mkdirSync(join(bundled, 'roles'), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(join(bundled, 'hud-convention.md'), 'bundled convention');
  fs.writeFileSync(join(bundled, 'roles', 'imp.json'), JSON.stringify(pi('imp', { model: 'bundled' })));
  fs.writeFileSync(join(bundled, 'roles', 'reviewer.json'), JSON.stringify(pi('reviewer', { model: 'bundled' })));
  return { root, hud, bundled, project, rm: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function register(hud, project) {
  const top = fs.realpathSync(project);
  fs.writeFileSync(
    join(hud, 'projects.json'),
    JSON.stringify({ version: 1, projects: [{ root: top, registered_at: '2026-11-13T00:00:00.000Z' }] })
  );
  return top;
}
function gitInit(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const result = spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

test('missing or unparseable projects.json registers nothing', () => {
  const { hud, project, rm } = layout();
  const missing = registeredProject(hud, project);
  assert.equal(missing.registered, false);
  assert.equal(missing.root, fs.realpathSync(project));
  assert.equal(missing.hud_dir, join(missing.root, '.hud'));
  fs.writeFileSync(join(hud, 'projects.json'), '{');
  assert.equal(registeredProject(hud, project).registered, false);
  fs.writeFileSync(join(hud, 'projects.json'), 'null');
  assert.equal(registeredProject(hud, project).registered, false);
  fs.writeFileSync(join(hud, 'projects.json'), JSON.stringify({ version: 2, projects: [{ root: missing.root }] }));
  assert.equal(registeredProject(hud, project).registered, false);
  rm();
});

test('project root is the git toplevel, including from a subdirectory', () => {
  const { hud, project, rm } = layout();
  gitInit(project);
  const sub = join(project, 'nested');
  fs.mkdirSync(sub);
  const top = fs.realpathSync(project);
  assert.equal(projectRoot(sub), top);
  assert.equal(registeredProject(hud, sub).registered, false);
  register(hud, project);
  assert.equal(registeredProject(hud, sub).root, top);
  assert.equal(registeredProject(hud, sub).registered, true);
  rm();
});

test('shared root is the main checkout for a linked worktree', () => {
  const { root, project, rm } = layout();
  gitInit(project);
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: project, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('commit', '--allow-empty', '-qm', 'base');
  const linked = join(root, 'linked');
  git('worktree', 'add', '-q', linked);
  const top = fs.realpathSync(project);
  assert.equal(projectRoot(linked), fs.realpathSync(linked));
  assert.equal(sharedRoot(linked), top);
  assert.equal(sharedRoot(join(project, '.')), top);
  const plain = join(root, 'plain');
  fs.mkdirSync(plain);
  assert.equal(sharedRoot(plain), projectRoot(plain));
  rm();
});

test('registered project roles override by name, hide unlisted roles and win the convention', () => {
  const { hud, bundled, project, rm } = layout();
  gitInit(project);
  const top = register(hud, project);
  fs.mkdirSync(join(project, 'nested'));
  fs.writeFileSync(join(hud, 'roles', 'imp.json'), JSON.stringify(pi('imp', { model: 'home' })));
  fs.mkdirSync(join(project, '.hud/roles'), { recursive: true });
  fs.writeFileSync(
    join(project, '.hud/roles/imp.json'),
    JSON.stringify(pi('imp', { model: 'project', skills: ['to-tickets'] }))
  );
  fs.writeFileSync(
    join(project, '.hud/roles/frontend.json'),
    JSON.stringify(pi('frontend', { model: 'project/frontend' }))
  );
  fs.writeFileSync(
    join(project, '.hud/project.json'),
    JSON.stringify({ version: 1, roles: ['imp', 'frontend', 'missing'] })
  );
  fs.writeFileSync(join(project, '.hud/hud-convention.md'), 'project convention');
  fs.writeFileSync(join(project, 'hud-convention.md'), 'cwd convention');
  fs.writeFileSync(join(hud, 'hud-convention.md'), 'home convention');
  const registry = roleRegistry(hud, join(project, 'nested'), {}, undefined, undefined, bundled);
  assert.equal(registry.project().root, top);
  assert.equal(registry.projectConfigIgnored(), null);
  assert.equal(registry.roles().get('imp').model, 'project');
  assert.equal(registry.roles().get('imp').source_file, join(top, '.hud/roles/imp.json'));
  assert.deepEqual(registry.roles().get('imp').skills, ['to-tickets']);
  assert.equal(registry.roles().get('frontend').source_file, join(top, '.hud/roles/frontend.json'));
  assert.equal(registry.roles().has('reviewer'), false);
  assert.equal(registry.roles().has('missing'), false);
  assert.equal(registry.convention().path, join(top, '.hud/hud-convention.md'));
  assert.equal(registry.convention().text, 'project convention');
  rm();
});

test('missing or unparseable project.json does not hide roles', () => {
  const { hud, bundled, project, rm } = layout();
  register(hud, project);
  fs.mkdirSync(join(project, '.hud'), { recursive: true });
  assert.equal(roleRegistry(hud, project, {}, undefined, undefined, bundled).roles().has('reviewer'), true);
  fs.writeFileSync(join(project, '.hud/project.json'), '{');
  assert.equal(roleRegistry(hud, project, {}, undefined, undefined, bundled).roles().has('reviewer'), true);
  fs.writeFileSync(join(project, '.hud/project.json'), JSON.stringify({ version: 1, roles: 'imp' }));
  assert.equal(roleRegistry(hud, project, {}, undefined, undefined, bundled).roles().has('reviewer'), true);
  rm();
});

test('an unregistered .hud is ignored', () => {
  const { hud, bundled, project, rm } = layout();
  gitInit(project);
  fs.mkdirSync(join(project, '.hud/roles'), { recursive: true });
  fs.writeFileSync(
    join(project, '.hud/roles/frontend.json'),
    JSON.stringify(pi('frontend', { model: 'SECRET_PROJECT_ROLE' }))
  );
  fs.writeFileSync(join(project, '.hud/hud-convention.md'), 'SECRET_CONVENTION');
  fs.writeFileSync(join(project, 'hud-convention.md'), 'cwd convention');
  const registry = roleRegistry(hud, project, {}, undefined, undefined, bundled);
  assert.equal(registry.project().registered, false);
  assert.equal(registry.projectConfigIgnored(), fs.realpathSync(project));
  assert.equal(registry.roles().has('frontend'), false);
  assert.equal(registry.roles().has('imp'), true);
  assert.equal(registry.convention().text, 'cwd convention');
  assert.equal(JSON.stringify([...registry.roles().values()]).includes('SECRET_PROJECT_ROLE'), false);
  rm();
});

test('project chains allow CLI routing only and still validate pi skills', () => {
  const { hud, bundled, project, rm } = layout();
  register(hud, project);
  fs.mkdirSync(join(project, '.hud/roles'), { recursive: true });
  const writeChain = (role, place) => {
    const file = join(project, '.hud/roles', `${role}.json`);
    fs.writeFileSync(file, JSON.stringify({ role, can_continue: true, run: [place] }));
    return file;
  };
  const cli = { harness: 'cli', agent: 'grok', model: 'synthetic-cli', thinking: 'high' };
  writeChain('local', cli);
  const cliArgs = writeChain('cli-args', { ...cli, args: ['--extra'] });
  const cliExtra = writeChain('cli-extra', { ...cli, note: 'SECRET_BODY' });
  const cliEffort = writeChain('cli-effort', { ...cli, effort: 'high' });
  const bro = writeChain('browser', { harness: 'bro', tool: 'jev-ask', provider: 'gemini' });
  const odd = join(project, '.hud/roles/odd.json');
  fs.writeFileSync(odd, JSON.stringify({ role: 'odd', harness: 'SECRET_HARNESS_VALUE', pi_role: 'implementer' }));
  const badPi = join(project, '.hud/roles/bad.json');
  fs.writeFileSync(badPi, JSON.stringify(pi('bad', { skills: ['ok', ''] })));
  const notArray = join(project, '.hud/roles/text.json');
  fs.writeFileSync(notArray, JSON.stringify(pi('text', { skills: 'to-tickets' })));
  const homeCli = join(hud, 'roles/home-cli.json');
  fs.writeFileSync(
    homeCli,
    JSON.stringify({ role: 'home-cli', harness: 'cli', agent: 'grok', can_continue: true, skills: ['x'] })
  );
  const homeJev = join(hud, 'roles/home-jev.json');
  fs.writeFileSync(
    homeJev,
    JSON.stringify({ role: 'home-jev', harness: 'jev', tool: 'jev-ask', provider: 'gemini', skills: ['x'] })
  );
  const good = join(hud, 'roles/skilled.json');
  fs.writeFileSync(good, JSON.stringify(pi('skilled', { skills: ['to-tickets'] })));
  const registry = roleRegistry(hud, project, {}, undefined, undefined, bundled);
  const reason = (path) => registry.invalid().find((item) => item.path === path);
  for (const path of [cliArgs, cliExtra, cliEffort])
    assert.deepEqual(reason(path), { path, reason: 'project CLI places take agent, model and thinking only' });
  assert.deepEqual(reason(bro), { path: bro, reason: 'project roles are pi or CLI only' });
  assert.deepEqual(reason(odd), { path: odd, reason: 'project roles are pi only in single-place format' });
  assert.deepEqual(reason(badPi), { path: badPi, reason: 'bad pi fields' });
  assert.deepEqual(reason(notArray), { path: notArray, reason: 'bad pi fields' });
  assert.deepEqual(reason(homeCli), { path: homeCli, reason: 'bad cli fields' });
  assert.deepEqual(reason(homeJev), { path: homeJev, reason: 'bad bro fields' });
  assert.deepEqual(registry.roles().get('local').run, [cli]);
  for (const name of ['cli-args', 'cli-extra', 'cli-effort', 'browser']) assert.equal(registry.roles().has(name), false);
  assert.deepEqual(registry.roles().get('skilled').skills, ['to-tickets']);
  assert.equal(JSON.stringify(registry.invalid()).includes('SECRET_BODY'), false);
  assert.equal(JSON.stringify(registry.invalid()).includes('SECRET_HARNESS_VALUE'), false);
  rm();
});

test('project files go through the injected readers and are skipped when unregistered', () => {
  const { hud, bundled, project, rm } = layout();
  const top = register(hud, project);
  fs.mkdirSync(join(project, '.hud/roles'), { recursive: true });
  const seen = [];
  const registry = roleRegistry(
    hud,
    project,
    {},
    (file) => {
      seen.push(['read', file]);
      return file === join(top, '.hud/hud-convention.md') ? { text: 'injected convention', truncated: false } : null;
    },
    (dir) => {
      seen.push(['list', dir]);
      return dir === join(top, '.hud/roles') ? ['frontend.json'] : [];
    },
    bundled,
    (file) => {
      seen.push(['json', file]);
      if (file === join(top, '.hud/roles/frontend.json')) return pi('frontend', { model: 'injected' });
      if (file === join(top, '.hud/project.json')) return { roles: ['frontend'] };
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    }
  );
  assert.equal(registry.roles().get('frontend').model, 'injected');
  assert.equal(registry.roles().has('imp'), false);
  assert.equal(registry.convention().text, 'injected convention');
  assert.ok(seen.some((item) => item[0] === 'list' && item[1] === join(top, '.hud/roles')));
  assert.ok(seen.some((item) => item[0] === 'json' && item[1] === join(top, '.hud/project.json')));
  assert.equal(seen.find((item) => item[0] === 'read')[1], join(top, '.hud/hud-convention.md'));

  fs.rmSync(join(hud, 'projects.json'));
  const ignored = [];
  const closed = roleRegistry(
    hud,
    project,
    {},
    (file) => {
      ignored.push(['read', file]);
      return null;
    },
    (dir) => {
      ignored.push(['list', dir]);
      return [];
    },
    bundled,
    (file) => {
      ignored.push(['json', file]);
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    }
  );
  assert.equal(closed.projectConfigIgnored(), top);
  assert.equal(
    ignored.some(
      (item) => String(item[1]).includes(`${join('project', '.hud')}`) || String(item[1]).includes('/.hud/')
    ),
    false
  );
  rm();
});
