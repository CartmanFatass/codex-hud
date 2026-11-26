// Synthetic fixtures and fake `gh` executable only; no network calls.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { main } from '../../dist/cli/hud.js';
import { scanScratch } from '../../dist/cli/tickets.js';
import { validateTicketFeature, type TicketFeatureDoc } from '../../dist/tickets/store.js';

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

function readMirrorDoc(project: string, slug: string): TicketFeatureDoc {
  const raw = fs.readFileSync(join(project, '.hud/tickets', `${slug}.json`), 'utf8');
  return validateTicketFeature(JSON.parse(raw), slug);
}

test('hud tickets sync writes JSON mirrors with mirror block and .gitignore, updates closed parents and removes detached issues', async (t) => {
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
  assert.equal(f.out(), 'auth-login-flow: 5 tickets\nissue-30: 1 tickets\nsynced 2 features, 6 tickets\n');

  // Verify `.hud/tickets/.gitignore`, JSON mirrors, and parent `.scratch/<slug>/spec.md` prose.
  assert.equal(fs.readFileSync(join(f.project, '.hud/tickets/.gitignore'), 'utf8'), '*\n');
  assert.equal(fs.readFileSync(join(f.project, '.scratch/auth-login-flow/.gitignore'), 'utf8'), '*\n');
  const specText = fs.readFileSync(join(f.project, '.scratch/auth-login-flow/spec.md'), 'utf8');
  assert.match(specText, new RegExp(`^<!-- Generated by hud tickets sync from ${baseUrl}/10 -->`));
  assert.match(specText, /# Auth & Login Flow!/);
  assert.match(specText, /Parent spec body\./);
  assert.equal(fs.existsSync(join(f.project, '.scratch/auth-login-flow/issues')), false);

  const authDoc = readMirrorDoc(f.project, 'auth-login-flow');
  assert.equal(authDoc.mirror?.kind, 'github');
  assert.equal(authDoc.mirror?.repo, repo);
  assert.equal(authDoc.mirror?.issue, 10);
  assert.equal(authDoc.mirror?.url, `${baseUrl}/10`);
  assert.equal(authDoc.spec_path, '.scratch/auth-login-flow/spec.md');
  assert.deepEqual(
    authDoc.tickets.map((r) => [r.number, r.status, r.acceptance.filter((a) => a.done).length, r.acceptance.length, r.blocked_by]),
    [
      [11, 'done', 1, 1, []],
      [12, 'wontfix', 1, 1, []],
      [13, 'claimed', 1, 2, []],
      [14, 'ready-for-agent', 0, 1, ['auth-login-flow/13']],
      [15, 'needs-triage', 0, 1, ['auth-login-flow/13']],
    ],
  );
  const t13 = authDoc.tickets.find((r) => r.number === 13)!;
  assert.equal(t13.what, 'Wire button.');
  assert.equal(t13.comments.length, 2);
  assert.equal(t13.comments[0].author, 'bob');
  assert.equal(t13.comments[0].text, 'First comment');
  assert.equal(t13.comments[1].author, 'carol');
  assert.equal(t13.comments[1].text, 'Latest comment here');

  const issue30Doc = readMirrorDoc(f.project, 'issue-30');
  assert.equal(issue30Doc.mirror?.issue, 30);
  assert.equal(issue30Doc.tickets.length, 1);
  assert.equal(issue30Doc.tickets[0].status, 'needs-info');

  // Local edits must be refused on a JSON mirror (even if `.scratch` is removed).
  assert.throws(
    () => scanScratch(join(f.project, '.scratch'), true),
    /refusing local ticket edits.*GitHub mirror.*gh.*op: sync/,
  );

  // Re-sync after parent #10 is closed, #12 is detached, and #13 is closed:
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

  const authDoc2 = readMirrorDoc(f.project, 'auth-login-flow');
  assert.deepEqual(
    authDoc2.tickets.map((r) => [r.number, r.status, r.blocked_by]),
    [
      [11, 'done', []],
      [13, 'done', []],
      [14, 'ready-for-agent', []],
      [15, 'needs-triage', []],
    ],
  );
  const issue30Doc2 = readMirrorDoc(f.project, 'issue-30');
  assert.equal(issue30Doc2.tickets.length, 0);
});

test('hud tickets sync refuses when .scratch or .hud/tickets holds local ticket files and writes nothing', async (t) => {
  // Case 1: Local Markdown tickets in `.scratch`
  {
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
    assert.equal(fs.existsSync(join(f.project, '.hud/tickets')), false);
  }

  // Case 2: Local JSON ticket store in `.hud/tickets` (no `mirror` block)
  {
    const f = setupEnv(t);
    const ticketsDir = join(f.project, '.hud/tickets');
    fs.mkdirSync(ticketsDir, { recursive: true });
    const localJson = join(ticketsDir, 'local-json.json');
    const original = JSON.stringify({ version: 1, feature: 'local-json', tickets: [] }, null, 2) + '\n';
    fs.writeFileSync(localJson, original);

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
    assert.match(f.err(), /non-generated ticket file at \.hud\/tickets\/local-json\.json/);
    assert.equal(f.out(), '');
    assert.equal(fs.readFileSync(localJson, 'utf8'), original);
    assert.equal(fs.existsSync(join(f.project, '.hud/tickets/remote-feature.json')), false);
  }

  // Case 3: Local edit refusal when ONLY `.hud/tickets/<slug>.json` mirror exists (no `.scratch/` dir)
  {
    const f = setupEnv(t);
    const ticketsDir = join(f.project, '.hud/tickets');
    fs.mkdirSync(ticketsDir, { recursive: true });
    fs.writeFileSync(
      join(ticketsDir, 'gh-mirror.json'),
      JSON.stringify({
        version: 1,
        feature: 'gh-mirror',
        mirror: {
          kind: 'github',
          repo: 'example/my-hud',
          issue: 10,
          url: 'https://github.com/example/my-hud/issues/10',
          synced_at: '2026-11-26T00:00:00.000Z',
        },
        tickets: [],
      }),
    );
    assert.throws(
      () => scanScratch(join(f.project, '.scratch'), true),
      /refusing local ticket edits.*GitHub mirror.*gh.*op: sync/,
    );
  }
});

test('hud tickets sync reports a mirror above the feature size cap and writes nothing', async (t) => {
  const f = setupEnv(t);
  const repo = 'example/sample', issues = `repos/${repo}/issues`;
  writeGhState(f.statePath, { repo, errors: {}, routes: {
    [issues]: [{ number: 1, title: 'Large mirror', state: 'open' }],
    [`${issues}/1/sub_issues`]: [2, 3].map(number => ({ number, title: `Issue ${number}`, state: 'open',
      body: 'a'.repeat(35_000), comments: 0 })),
  } });
  assert.equal(await main(['tickets', 'sync', '--cwd', f.project], f.io), 1);
  assert.match(f.err(), /cannot sync large-mirror: Ticket feature large-mirror exceeds 64 KiB/);
  assert.equal(fs.existsSync(join(f.project, '.hud/tickets')), false);
  assert.equal(fs.existsSync(join(f.project, '.scratch')), false);
});

test('hud tickets sync exits non-zero and changes nothing when gh is missing or fails', async (t) => {
  const f = setupEnv(t);
  const missingGhCode = await main(['tickets', 'sync', '--cwd', f.project], {
    ...f.io,
    env: { HOME: f.home, HUD_HOME: f.hud, PATH: '' },
  });
  assert.notEqual(missingGhCode, 0);
  assert.match(f.err(), /gh is missing/);
  assert.equal(fs.existsSync(join(f.project, '.hud/tickets')), false);
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
  assert.equal(fs.existsSync(join(f.project, '.hud/tickets')), false);
  assert.equal(fs.existsSync(join(f.project, '.scratch')), false);
});

test('hud tickets sync reserves existing mirror slug so newcomer with same title gets suffixed slug and cleans legacy .scratch issues', async (t) => {
  const f = setupEnv(t);
  const repo = 'example/my-hud';
  const baseUrl = `https://github.com/${repo}/issues`;

  // Seed legacy Markdown mirror for #10 to verify seamless upgrade + cleanup.
  fs.mkdirSync(join(f.project, '.scratch/auth-flow/issues'), { recursive: true });
  fs.writeFileSync(
    join(f.project, '.scratch/auth-flow/spec.md'),
    `<!-- Generated by hud tickets sync from ${baseUrl}/10 -->\n# Auth Flow\n`,
  );
  fs.writeFileSync(
    join(f.project, '.scratch/auth-flow/issues/11-old-task.md'),
    `<!-- Generated by hud tickets sync from ${baseUrl}/11 -->\n# 11: Old task\n`,
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
  assert.equal(readMirrorDoc(f.project, 'auth-flow').mirror?.issue, 10);
  assert.equal(readMirrorDoc(f.project, 'auth-flow').tickets[0].number, 11);
  assert.equal(fs.existsSync(join(f.project, '.scratch/auth-flow/issues/11-old-task.md')), false);

  assert.equal(readMirrorDoc(f.project, 'auth-flow-50').mirror?.issue, 50);
  assert.equal(readMirrorDoc(f.project, 'auth-flow-50').tickets[0].number, 51);
  assert.equal(fs.existsSync(join(f.project, '.hud/tickets/auth-flow-10.json')), false);
});

test('hud tickets sync keeps distinct slugs for Foo 13 (#20), Foo (#7), and existing foo (#13) including when foo-13 exists', async (t) => {
  const repo = 'example/my-hud';
  const baseUrl = `https://github.com/${repo}/issues`;

  // Case 1: existing JSON mirror `foo` for #13 -> three distinct JSON mirrors; re-sync preserves mapping.
  {
    const f = setupEnv(t);
    fs.mkdirSync(join(f.project, '.hud/tickets'), { recursive: true });
    fs.writeFileSync(
      join(f.project, '.hud/tickets/foo.json'),
      JSON.stringify({
        version: 1,
        feature: 'foo',
        mirror: { kind: 'github', repo, issue: 13, url: `${baseUrl}/13`, synced_at: '2026-11-25T00:00:00.000Z' },
        tickets: [],
      }),
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
    assert.equal(readMirrorDoc(f.project, 'foo-13').mirror?.issue, 20);
    assert.equal(readMirrorDoc(f.project, 'foo-13').tickets[0].number, 21);
    assert.equal(readMirrorDoc(f.project, 'foo-7').mirror?.issue, 7);
    assert.equal(readMirrorDoc(f.project, 'foo-7').tickets[0].number, 8);
    assert.equal(readMirrorDoc(f.project, 'foo').mirror?.issue, 13);
    assert.equal(readMirrorDoc(f.project, 'foo').tickets[0].number, 14);
  }

  // Case 2: `foo-13` and `foo-7` already exist as generated mirrors for other parents -> loop until unused.
  {
    const f = setupEnv(t);
    fs.mkdirSync(join(f.project, '.hud/tickets'), { recursive: true });
    for (const [slug, num] of [
      ['foo', 13],
      ['foo-13', 99],
      ['foo-7', 88],
    ] as const) {
      fs.writeFileSync(
        join(f.project, '.hud/tickets', `${slug}.json`),
        JSON.stringify({
          version: 1,
          feature: slug,
          mirror: { kind: 'github', repo, issue: num, url: `${baseUrl}/${num}`, synced_at: '2026-11-25T00:00:00.000Z' },
          tickets: [],
        }),
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
    assert.equal(readMirrorDoc(f.project, 'foo-13-20').mirror?.issue, 20);
    assert.equal(readMirrorDoc(f.project, 'foo-13-20').tickets[0].number, 21);
    assert.equal(readMirrorDoc(f.project, 'foo-7-7').mirror?.issue, 7);
    assert.equal(readMirrorDoc(f.project, 'foo-7-7').tickets[0].number, 8);
    assert.equal(readMirrorDoc(f.project, 'foo').mirror?.issue, 13);
    assert.equal(readMirrorDoc(f.project, 'foo').tickets[0].number, 14);
    assert.equal(readMirrorDoc(f.project, 'foo-13').mirror?.issue, 99);
    assert.equal(readMirrorDoc(f.project, 'foo-7').mirror?.issue, 88);
  }
});
