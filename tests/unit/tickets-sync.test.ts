// Synthetic fixtures and fake `gh` executable only; no network calls.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { main } from '../../dist/cli/hud.js';
import { ProjectCollector } from '../../dist/collectors/project-board.js';

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);

function setupEnv(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hud-tickets-sync-')));
  const home = join(root, 'home');
  const hud = join(root, 'hud');
  const project = join(root, 'project');
  const bin = join(root, 'bin');
  const statePath = join(root, 'gh-state.json');
  fs.mkdirSync(home);
  fs.mkdirSync(hud, { mode: 0o700 });
  fs.mkdirSync(project);
  fs.mkdirSync(bin);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const fakeGh = `#!${process.execPath}
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'));
const args = process.argv.slice(2);
if (state.failOn && args.join(' ').includes(state.failOn)) {
  console.error('gh: simulated API failure');
  process.exit(1);
}
if (args[0] === 'repo' && args[1] === 'view') {
  console.log(JSON.stringify({ nameWithOwner: state.repo }));
  process.exit(0);
}
if (args[0] === 'api') {
  const endpoint = args.find((a) => a.startsWith('repos/')) ?? '';
  const clean = endpoint.split('?')[0];
  if (clean in state.errors) {
    console.error(state.errors[clean]);
    process.exit(1);
  }
  if (clean in state.routes) {
    console.log(JSON.stringify(state.routes[clean]));
    process.exit(0);
  }
  console.error('gh: HTTP 404 Not Found: ' + clean);
  process.exit(1);
}
console.error('unexpected gh args: ' + args.join(' '));
process.exit(2);
`;
  fs.writeFileSync(join(bin, 'gh'), fakeGh, { mode: 0o700 });

  let stdout = '';
  let stderr = '';
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    HUD_HOME: hud,
    PATH: `${bin}:${dirname(process.execPath)}`,
  };
  const io = {
    env,
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
    statePath,
    env,
    io,
    out: () => stdout,
    err: () => stderr,
    reset: () => {
      stdout = '';
      stderr = '';
    },
  };
}

function writeGhState(path: string, state: unknown): void {
  fs.writeFileSync(path, JSON.stringify(state));
}

test('hud tickets sync mirrors parent/sub-issues, updates closed parents and round-trips through ProjectCollector', async (t) => {
  const f = setupEnv(t);
  const repo = 'example/my-hud';
  const baseUrl = `https://github.com/${repo}/issues`;

  const parent10 = {
    number: 10,
    title: 'Auth & Login Flow!',
    body: 'Parent spec body.\n\n- Scope item',
    state: 'open',
    html_url: `${baseUrl}/10`,
  };
  const issue11 = {
    number: 11,
    title: 'Setup schema',
    body: '- [x] Create table',
    state: 'closed',
    state_reason: 'completed',
    html_url: `${baseUrl}/11`,
    comments: 0,
  };
  const issue12 = {
    number: 12,
    title: 'Legacy migration',
    body: '- [x] Ignored checkbox',
    state: 'closed',
    state_reason: 'not_planned',
    html_url: `${baseUrl}/12`,
    comments: 0,
  };
  const issue13 = {
    number: 13,
    title: 'Add login button',
    body: 'Wire button.\n\n- [x] Render button\n- [ ] Handle click',
    state: 'open',
    assignee: { login: 'alice' },
    assignees: [{ login: 'alice' }],
    labels: [{ name: 'ready-for-agent' }],
    html_url: `${baseUrl}/13`,
  };
  const issue14 = {
    number: 14,
    title: 'Session refresh',
    body: '- [ ] Refresh token',
    state: 'open',
    labels: [{ name: 'bug' }, { name: 'ready-for-agent' }],
    html_url: `${baseUrl}/14`,
    comments: 0,
  };
  const issue15 = {
    number: 15,
    title: 'Audit logs',
    body: 'Blocked by: #13, #11\n\n- [ ] Emit event',
    state: 'open',
    labels: [{ name: 'enhancement' }],
    html_url: `${baseUrl}/15`,
    comments: 0,
  };
  const parent30 = {
    number: 30,
    title: '中文标题',
    body: 'Non-ASCII title falls back to issue-30.',
    state: 'open',
    html_url: `${baseUrl}/30`,
  };
  const issue31 = {
    number: 31,
    title: '准备文档',
    body: '- [ ] Draft doc',
    state: 'open',
    labels: [{ name: 'needs-info' }],
    html_url: `${baseUrl}/31`,
    comments: 0,
  };

  writeGhState(f.statePath, {
    repo,
    errors: {},
    routes: {
      [`repos/${repo}/issues`]: [
        parent10,
        parent30,
        { number: 20, title: 'Standalone', state: 'open', sub_issues_summary: { total: 0 } },
        { number: 21, title: 'PR item', state: 'open', pull_request: {} },
      ],
      [`repos/${repo}/issues/10/sub_issues`]: [[issue11, issue12, issue13, issue14, issue15]],
      [`repos/${repo}/issues/30/sub_issues`]: [issue31],
      [`repos/${repo}/issues/13/comments`]: [
        { user: { login: 'bob' }, created_at: '2026-11-15T10:00:00Z', body: 'First comment\nSecond line' },
        { user: { login: 'carol' }, created_at: '2026-11-16T08:30:00Z', body: '\nLatest comment here\nMore details' },
      ],
      [`repos/${repo}/issues/13/dependencies/blocked_by`]: [],
      [`repos/${repo}/issues/14/dependencies/blocked_by`]: [issue13, issue11],
      [`repos/${repo}/issues/31/dependencies/blocked_by`]: [],
      // Intentionally omit 15/dependencies/blocked_by so fake gh returns 404 -> falls back to body Blocked by.
    },
  });

  const code = await main(['tickets', 'sync', '--cwd', f.project], f.io);
  assert.equal(code, 0, f.err());
  assert.equal(
    f.out(),
    'auth-login-flow: 5 tickets\nissue-30: 1 tickets\nsynced 2 features, 6 tickets\n'
  );

  // Verify generated .gitignore, spec.md and ticket files.
  assert.equal(fs.readFileSync(join(f.project, '.scratch/auth-login-flow/.gitignore'), 'utf8'), '*\n');
  const specText = fs.readFileSync(join(f.project, '.scratch/auth-login-flow/spec.md'), 'utf8');
  assert.match(specText, new RegExp(`^<!-- Generated by hud tickets sync from ${baseUrl}/10 -->`));
  assert.match(specText, /# Auth & Login Flow!/);
  assert.match(specText, /Parent spec body\./);

  const ticket13 = fs.readFileSync(join(f.project, '.scratch/auth-login-flow/issues/13-add-login-button.md'), 'utf8');
  assert.match(ticket13, new RegExp(`^<!-- Generated by hud tickets sync from ${baseUrl}/13 -->`));
  assert.match(ticket13, /\*\*Status:\*\* claimed/);
  assert.match(ticket13, /\*\*Blocked by:\*\* none/);
  assert.match(ticket13, /## Comments\n\n- 2026-11-15 bob: First comment\n- 2026-11-16 carol: Latest comment here/);

  const ticket15 = fs.readFileSync(join(f.project, '.scratch/auth-login-flow/issues/15-audit-logs.md'), 'utf8');
  assert.match(ticket15, /\*\*Status:\*\* needs-triage/);
  assert.match(ticket15, /\*\*Blocked by:\*\* 13$/m);

  assert.ok(fs.existsSync(join(f.project, '.scratch/issue-30/issues/31-issue-31.md')));

  // Create a synthetic HUD job mentioning #13 to verify ProjectCollector job <-> ticket linking.
  const jobDir = join(f.hud, 'jobs', 'j0000000000000013');
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(
    join(jobDir, 'job.json'),
    JSON.stringify({
      job: 'j0000000000000013',
      role: 'imp',
      package: 'auth-login-flow',
      task: 'Implement #13',
      cwd: f.project,
      created_at: new Date(NOW - 60_000).toISOString(),
    })
  );
  fs.writeFileSync(join(jobDir, 'STATUS.json'), JSON.stringify({ state: 'working' }));

  const collector = new ProjectCollector(f.project, f.hud, f.env, f.home);
  const snap = await collector.collect(true, { workers: [], lanes: [] } as never, NOW);
  assert.ok(snap);
  const auth = snap.tickets.find((feat) => feat.slug === 'auth-login-flow');
  assert.ok(auth);
  assert.deepEqual(
    auth.tickets.map((r) => [r.number, r.status, r.state, r.checked, r.total, r.blockers]),
    [
      ['11', 'resolved', 'done', 1, 1, []],
      ['12', 'wontfix', 'dropped', 1, 1, []],
      ['13', 'claimed', 'working', 1, 2, []],
      ['14', 'ready-for-agent', 'queued', 0, 1, ['13']],
      ['15', 'needs-triage', 'blocked', 0, 1, ['13']],
    ]
  );
  assert.equal(auth.tickets.find((r) => r.number === '13')?.comment, '2026-11-16 carol: Latest comment here');
  assert.equal(auth.tickets.find((r) => r.number === '13')?.job?.role, 'imp');

  const issue30 = snap.tickets.find((feat) => feat.slug === 'issue-30');
  assert.ok(issue30);
  assert.equal(issue30.tickets[0].status, 'needs-info');

  // Re-sync after parent #10 is closed, #12 is detached, and #13 is closed:
  // Closed parent still syncs via existing mirror directory, detached #12 is removed, #14/#15 unblock.
  f.reset();
  const closedParent10 = { ...parent10, state: 'closed', state_reason: 'completed' };
  const closed13 = { ...issue13, state: 'closed', state_reason: 'completed' };
  writeGhState(f.statePath, {
    repo,
    errors: {},
    routes: {
      [`repos/${repo}/issues`]: [],
      [`repos/${repo}/issues/10`]: closedParent10,
      [`repos/${repo}/issues/10/sub_issues`]: [issue11, closed13, issue14, issue15],
      [`repos/${repo}/issues/30`]: { ...parent30, state: 'closed', state_reason: 'completed' },
      [`repos/${repo}/issues/30/sub_issues`]: [],
      [`repos/${repo}/issues/13`]: closed13,
      [`repos/${repo}/issues/13/comments`]: [],
      [`repos/${repo}/issues/13/dependencies/blocked_by`]: [],
      [`repos/${repo}/issues/14/dependencies/blocked_by`]: [closed13, issue11],
    },
  });

  const code2 = await main(['tickets', 'sync', '--cwd', f.project], f.io);
  assert.equal(code2, 0, f.err());
  assert.equal(fs.existsSync(join(f.project, '.scratch/auth-login-flow/issues/12-legacy-migration.md')), false);
  assert.equal(fs.existsSync(join(f.project, '.scratch/issue-30/issues/31-issue-31.md')), false);

  const snap2 = await collector.collect(true, { workers: [], lanes: [] } as never, NOW + 1000);
  const auth2 = snap2?.tickets.find((feat) => feat.slug === 'auth-login-flow');
  assert.deepEqual(
    auth2?.tickets.map((r) => [r.number, r.status, r.state, r.blockers]),
    [
      ['11', 'resolved', 'done', []],
      ['13', 'resolved', 'done', []],
      ['14', 'ready-for-agent', 'ready', []],
      ['15', 'needs-triage', 'blocked', []],
    ]
  );
});

test('hud tickets sync refuses when .scratch holds non-generated ticket files and writes nothing', async (t) => {
  const f = setupEnv(t);
  const localDir = join(f.project, '.scratch/local-feature/issues');
  fs.mkdirSync(localDir, { recursive: true });
  const localFile = join(localDir, '01-local-task.md');
  const original = '# 01: Local task\n\n**Status:** ready-for-agent\n**Blocked by:** none\n';
  fs.writeFileSync(localFile, original);

  writeGhState(f.statePath, {
    repo: 'example/my-hud',
    errors: {},
    routes: {
      'repos/example/my-hud/issues': [{ number: 1, title: 'Remote feature', state: 'open' }],
      'repos/example/my-hud/issues/1/sub_issues': [{ number: 2, title: 'Sub', state: 'open', comments: 0 }],
      'repos/example/my-hud/issues/2/dependencies/blocked_by': [],
    },
  });

  const code = await main(['tickets', 'sync', '--cwd', f.project], f.io);
  assert.notEqual(code, 0);
  assert.match(f.err(), /non-generated ticket file/);
  assert.equal(f.out(), '');
  assert.equal(fs.readFileSync(localFile, 'utf8'), original);
  assert.equal(fs.existsSync(join(f.project, '.scratch/remote-feature')), false);
});

test('hud tickets sync exits non-zero and changes nothing when gh is missing or fails', async (t) => {
  const f = setupEnv(t);
  const missingGhCode = await main(['tickets', 'sync', '--cwd', f.project], {
    ...f.io,
    env: { HOME: f.home, HUD_HOME: f.hud, PATH: '' },
  });
  assert.notEqual(missingGhCode, 0);
  assert.match(f.err(), /gh is missing/);
  assert.equal(fs.existsSync(join(f.project, '.scratch')), false);

  f.reset();
  writeGhState(f.statePath, {
    repo: 'example/my-hud',
    failOn: 'sub_issues',
    errors: {},
    routes: {
      'repos/example/my-hud/issues': [{ number: 1, title: 'Feature', state: 'open' }],
    },
  });
  const apiFailCode = await main(['tickets', 'sync', '--cwd', f.project], f.io);
  assert.notEqual(apiFailCode, 0);
  assert.match(f.err(), /simulated API failure/);
  assert.equal(fs.existsSync(join(f.project, '.scratch')), false);
});

test('hud tickets sync reserves existing mirror dir so newcomer with same title gets suffixed dir', async (t) => {
  const f = setupEnv(t);
  const repo = 'example/my-hud';
  const baseUrl = `https://github.com/${repo}/issues`;

  fs.mkdirSync(join(f.project, '.scratch/auth-flow/issues'), { recursive: true });
  fs.writeFileSync(
    join(f.project, '.scratch/auth-flow/spec.md'),
    `<!-- Generated by hud tickets sync from ${baseUrl}/10 -->\n# Auth Flow\n`
  );
  fs.writeFileSync(
    join(f.project, '.scratch/auth-flow/issues/11-old-task.md'),
    `<!-- Generated by hud tickets sync from ${baseUrl}/11 -->\n# 11: Old task\n`
  );

  writeGhState(f.statePath, {
    repo,
    errors: {},
    routes: {
      [`repos/${repo}/issues`]: [{ number: 50, title: 'Auth Flow', state: 'open' }],
      [`repos/${repo}/issues/50/sub_issues`]: [{ number: 51, title: 'New task', state: 'open', comments: 0 }],
      [`repos/${repo}/issues/51/dependencies/blocked_by`]: [],
      [`repos/${repo}/issues/10`]: { number: 10, title: 'Auth Flow', state: 'closed', state_reason: 'completed' },
      [`repos/${repo}/issues/10/sub_issues`]: [
        { number: 11, title: 'Old task', state: 'closed', state_reason: 'completed', comments: 0 },
      ],
    },
  });

  const code = await main(['tickets', 'sync', '--cwd', f.project], f.io);
  assert.equal(code, 0, f.err());
  assert.match(fs.readFileSync(join(f.project, '.scratch/auth-flow/spec.md'), 'utf8'), new RegExp(`${baseUrl}/10 -->`));
  assert.ok(fs.existsSync(join(f.project, '.scratch/auth-flow/issues/11-old-task.md')));
  assert.match(
    fs.readFileSync(join(f.project, '.scratch/auth-flow-50/spec.md'), 'utf8'),
    new RegExp(`${baseUrl}/50 -->`)
  );
  assert.ok(fs.existsSync(join(f.project, '.scratch/auth-flow-50/issues/51-new-task.md')));
  assert.equal(fs.existsSync(join(f.project, '.scratch/auth-flow-10')), false);
});

test('hud tickets sync keeps distinct dirs for Foo 13 (#20), Foo (#7), and existing foo (#13) including when foo-13 exists', async (t) => {
  const repo = 'example/my-hud';
  const baseUrl = `https://github.com/${repo}/issues`;

  // Case 1: existing `foo` for #13, `foo-13` does not exist yet -> three distinct dirs; then re-run when `foo-13` exists with stale file.
  {
    const f = setupEnv(t);
    fs.mkdirSync(join(f.project, '.scratch/foo/issues'), { recursive: true });
    fs.writeFileSync(
      join(f.project, '.scratch/foo/spec.md'),
      `<!-- Generated by hud tickets sync from ${baseUrl}/13 -->\n# Foo\n`
    );

    writeGhState(f.statePath, {
      repo,
      errors: {},
      routes: {
        [`repos/${repo}/issues`]: [
          { number: 20, title: 'Foo 13', state: 'open' },
          { number: 7, title: 'Foo', state: 'open' },
          { number: 13, title: 'Foo', state: 'open' },
        ],
        [`repos/${repo}/issues/20/sub_issues`]: [{ number: 21, title: 'Sub 20', state: 'open', comments: 0 }],
        [`repos/${repo}/issues/7/sub_issues`]: [{ number: 8, title: 'Sub 7', state: 'open', comments: 0 }],
        [`repos/${repo}/issues/13/sub_issues`]: [{ number: 14, title: 'Sub 13', state: 'open', comments: 0 }],
        [`repos/${repo}/issues/21/dependencies/blocked_by`]: [],
        [`repos/${repo}/issues/8/dependencies/blocked_by`]: [],
        [`repos/${repo}/issues/14/dependencies/blocked_by`]: [],
      },
    });

    const code = await main(['tickets', 'sync', '--cwd', f.project], f.io);
    assert.equal(code, 0, f.err());
    assert.match(fs.readFileSync(join(f.project, '.scratch/foo-13/spec.md'), 'utf8'), new RegExp(`${baseUrl}/20 -->`));
    assert.ok(fs.existsSync(join(f.project, '.scratch/foo-13/issues/21-sub-20.md')));
    assert.match(fs.readFileSync(join(f.project, '.scratch/foo-7/spec.md'), 'utf8'), new RegExp(`${baseUrl}/7 -->`));
    assert.ok(fs.existsSync(join(f.project, '.scratch/foo-7/issues/8-sub-7.md')));
    assert.match(fs.readFileSync(join(f.project, '.scratch/foo/spec.md'), 'utf8'), new RegExp(`${baseUrl}/13 -->`));
    assert.ok(fs.existsSync(join(f.project, '.scratch/foo/issues/14-sub-13.md')));

    f.reset();
    fs.writeFileSync(
      join(f.project, '.scratch/foo-13/issues/99-stale.md'),
      `<!-- Generated by hud tickets sync from ${baseUrl}/99 -->\n# 99: Stale\n`
    );
    const code2 = await main(['tickets', 'sync', '--cwd', f.project], f.io);
    assert.equal(code2, 0, f.err());
    assert.equal(fs.existsSync(join(f.project, '.scratch/foo-13/issues/99-stale.md')), false);
    assert.ok(fs.existsSync(join(f.project, '.scratch/foo-13/issues/21-sub-20.md')));
    assert.ok(fs.existsSync(join(f.project, '.scratch/foo-7/issues/8-sub-7.md')));
    assert.ok(fs.existsSync(join(f.project, '.scratch/foo/issues/14-sub-13.md')));
  }

  // Case 2: `foo-13` and `foo-7` already exist as generated mirrors for other parents -> loop until unused.
  {
    const f = setupEnv(t);
    for (const [slug, num, title] of [
      ['foo', 13, 'Foo'],
      ['foo-13', 99, 'Foo 13'],
      ['foo-7', 88, 'Foo 7'],
    ] as const) {
      fs.mkdirSync(join(f.project, '.scratch', slug, 'issues'), { recursive: true });
      fs.writeFileSync(
        join(f.project, '.scratch', slug, 'spec.md'),
        `<!-- Generated by hud tickets sync from ${baseUrl}/${num} -->\n# ${title}\n`
      );
      fs.writeFileSync(
        join(f.project, '.scratch', slug, 'issues', `${num}0-stale.md`),
        `<!-- Generated by hud tickets sync from ${baseUrl}/${num}0 -->\n# ${num}0: Stale\n`
      );
    }

    writeGhState(f.statePath, {
      repo,
      errors: {},
      routes: {
        [`repos/${repo}/issues`]: [
          { number: 20, title: 'Foo 13', state: 'open' },
          { number: 7, title: 'Foo', state: 'open' },
          { number: 13, title: 'Foo', state: 'open' },
        ],
        [`repos/${repo}/issues/20/sub_issues`]: [{ number: 21, title: 'Sub 20', state: 'open', comments: 0 }],
        [`repos/${repo}/issues/7/sub_issues`]: [{ number: 8, title: 'Sub 7', state: 'open', comments: 0 }],
        [`repos/${repo}/issues/13/sub_issues`]: [{ number: 14, title: 'Sub 13', state: 'open', comments: 0 }],
        [`repos/${repo}/issues/99`]: { number: 99, title: 'Foo 13', state: 'closed', state_reason: 'completed' },
        [`repos/${repo}/issues/99/sub_issues`]: [],
        [`repos/${repo}/issues/88`]: { number: 88, title: 'Foo 7', state: 'closed', state_reason: 'completed' },
        [`repos/${repo}/issues/88/sub_issues`]: [],
        [`repos/${repo}/issues/21/dependencies/blocked_by`]: [],
        [`repos/${repo}/issues/8/dependencies/blocked_by`]: [],
        [`repos/${repo}/issues/14/dependencies/blocked_by`]: [],
      },
    });

    const code = await main(['tickets', 'sync', '--cwd', f.project], f.io);
    assert.equal(code, 0, f.err());
    assert.match(
      fs.readFileSync(join(f.project, '.scratch/foo-13-20/spec.md'), 'utf8'),
      new RegExp(`${baseUrl}/20 -->`)
    );
    assert.ok(fs.existsSync(join(f.project, '.scratch/foo-13-20/issues/21-sub-20.md')));
    assert.match(fs.readFileSync(join(f.project, '.scratch/foo-7-7/spec.md'), 'utf8'), new RegExp(`${baseUrl}/7 -->`));
    assert.ok(fs.existsSync(join(f.project, '.scratch/foo-7-7/issues/8-sub-7.md')));
    assert.match(fs.readFileSync(join(f.project, '.scratch/foo/spec.md'), 'utf8'), new RegExp(`${baseUrl}/13 -->`));
    assert.ok(fs.existsSync(join(f.project, '.scratch/foo/issues/14-sub-13.md')));
    assert.match(fs.readFileSync(join(f.project, '.scratch/foo-13/spec.md'), 'utf8'), new RegExp(`${baseUrl}/99 -->`));
    assert.match(fs.readFileSync(join(f.project, '.scratch/foo-7/spec.md'), 'utf8'), new RegExp(`${baseUrl}/88 -->`));
  }
});
