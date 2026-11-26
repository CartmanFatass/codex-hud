// Synthetic fixtures only; temporary HOME / HUD_HOME.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { main } from '../../dist/cli/hud.js';
import {
  diffTicketFacts,
  extractTicketFacts,
  migrateTickets,
  parseMarkdownTicket,
} from '../../dist/tickets/migrate.js';
import { renderTicketBrief, validateTicketFeature, type TicketFeatureDoc } from '../../dist/tickets/store.js';

function setupEnv(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hud-tickets-migrate-')));
  const home = join(root, 'home');
  const hud = join(root, 'hud');
  const project = join(root, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(hud, { mode: 0o700 });
  fs.mkdirSync(project);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let stdout = '';
  let stderr = '';
  const env: NodeJS.ProcessEnv = { HOME: home, HUD_HOME: hud };
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

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(join(filePath, '..'), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function seedComprehensiveFixture(project: string) {
  // Objective links file
  writeFile(
    join(project, '.hud/objectives.md'),
    [
      '**Stance:** active',
      '',
      '## alpha-obj: Alpha synthetic objective',
      '**State:** active',
      '**Features:** feat-alpha, feat-flakes',
      '',
      '## beta-obj: Beta override objective',
      '**State:** active',
      '**Features:** feat-other',
      '',
    ].join('\n'),
  );

  // Feature spec & prose notes that must survive --delete-legacy
  writeFile(join(project, '.scratch/feat-alpha/spec.md'), '# Alpha spec\n\nProse design stays Markdown.\n');
  writeFile(join(project, '.scratch/feat-alpha/notes.md'), '# Extra notes\n\nKeep this file.\n');

  // Ticket 01: Standard header + Owner try + Live try + Approved removals + normalized blockers +
  // Landed replay-base line + unattended lead acceptance + dated/multi-line comments.
  writeFile(
    join(project, '.scratch/feat-alpha/issues/01-standard-variant.md'),
    [
      '# 01: Standard ticket with full headers',
      '',
      '**Status:** done',
      '**Owner try:** yes',
      '**Live try:** Open panel and verify row alignment',
      '**Approved removals:** Old bar; Legacy hook.',
      '**Blocked by:** none (can start immediately)',
      '**Repairs:** FEAT-FLAKES 01 (related fixture)',
      '**Objective:** alpha-obj',
      '',
      '**What to build:** Build the synthetic standard path with deterministic output.',
      '',
      '- [x] Renders cleanly',
      '- [x] Wrapped acceptance item',
      '      spanning two lines cleanly',
      '',
      '## Comments',
      '',
      '- 2026-11-20 main: Initial note with details',
      '  continued on line two.',
      '  ',
      '  - nested detail',
      '- Landed in this commit (replay base 8ef7617b13b00a34554d9c70c5769834cd46a997); gate 5/5 passed.',
      '- Accepted by unattended lead (q0123456789abcdef): All checks green.',
      '',
    ].join('\n'),
  );

  // Ticket 02: Legacy `resolved` -> `done`, description-first (`**What:**`), `·`-joined `Who`/`Size`/`Blocked by`/`Status`
  // line, frontend-implementer role, cross-feature and local blockers, `## Comment (author, date)` heading, Landed SHA.
  writeFile(
    join(project, '.scratch/feat-alpha/issues/02-legacy-supervisor-style.md'),
    [
      '# 02: Legacy supervisor layout with resolved status',
      '',
      '**What:** Extract shared formatter into a pure helper.',
      '',
      '**Who:** frontend-implementer · **Size:** ~80 lines · **Blocked by:** 01, FEAT-FLAKES 01 (same lane) · **Status:** resolved (90ef78cd, stopgap)',
      '**Main review:** yes',
      '**Objective:** beta-obj',
      '',
      '- [x] Pure helper exported',
      '- [ ] Follow-up cleanup',
      '',
      '## Comment (orchestrator, 2026-11-14)',
      '',
      '- Landed b6df17f1f59edceb8ad3609565ebd4d5a98a8a3a; gate 6/6 passed.',
      '- Plain bullet without date.',
      '',
    ].join('\n'),
  );

  // Ticket 03: Duplicate `## Comments` heading, plain prose comment, `**What to demonstrate:**`, owner accepted status note.
  writeFile(
    join(project, '.scratch/feat-alpha/issues/03-owner-accepted-prose.md'),
    [
      '# 03: Demonstrate journey',
      '',
      '**Status:** done (accepted by the owner; see STATE ledger)',
      '**Blocked by:** 01, 02, OTHER-PROJECT landed',
      '',
      '**What to demonstrate:** Show synthetic end-to-end flow without polling.',
      '',
      '- [x] Recorded in synthetic run',
      '',
      '## Comments',
      '',
      '## Comments',
      '',
      'Plain prose comment without a leading bullet.',
      '',
    ].join('\n'),
  );

  // Ticket 01 in feat-flakes: Flake-list running ticket with `### Cases` (named + unidentified) and `## Live try` heading.
  writeFile(
    join(project, '.scratch/feat-flakes/issues/01-gate-flakes.md'),
    [
      '# 01: Gate flakes collected after release',
      '',
      '**Status:** ready-for-agent',
      '**Owner try:** no',
      '**Blocked by:** none',
      '',
      '**What to build:** Running list of gate flakes that passed on rerun. Cases: (1) `legacy inline flake` (tests/unit/legacy.test.mjs), gate f0000000000000001.',
      '',
      '### Cases',
      '',
      '- `flaky test alpha` (tests/unit/alpha.test.mjs) — flow `fa86a2f51f78f4b90`, log `~/.hud/flows/fa86a2f51f78f4b90.json.gate-1.log`',
      '- unidentified failure (`test:mjs`, tests/unit/beta.test.mjs) — flow `fb91cb6d28dbf6c54`',
      '',
      '## Live try',
      '',
      'Run the flaky suite 20 times.',
      '',
      'Review the report afterward.',
      '',
      '- [ ] Each listed case passes 20 consecutive runs',
      '- [ ] No assertion weakened',
      '',
      '## Comments',
      '',
    ].join('\n'),
  );
}

test('hud tickets migrate converts all header/section variants losslessly, keeps prose, and is idempotent', async (t) => {
  const f = setupEnv(t);
  seedComprehensiveFixture(f.project);

  // Run 1: migrate without --delete-legacy
  const code1 = await main(['tickets', 'migrate', '--cwd', f.project], f.io);
  assert.equal(code1, 0, f.err());
  assert.match(f.out(), /migrated 2 features, 4 tickets \(2 written, 0 unchanged\)/);

  // Markdown files remain untouched without --delete-legacy.
  assert.ok(fs.existsSync(join(f.project, '.scratch/feat-alpha/issues/01-standard-variant.md')));
  assert.ok(fs.existsSync(join(f.project, '.scratch/feat-flakes/issues/01-gate-flakes.md')));

  // Validate generated JSON files against the schema and compare every fact to parsed Markdown.
  const alphaRaw = fs.readFileSync(join(f.project, '.hud/tickets/feat-alpha.json'), 'utf8');
  const flakesRaw = fs.readFileSync(join(f.project, '.hud/tickets/feat-flakes.json'), 'utf8');
  const alphaDoc = validateTicketFeature(JSON.parse(alphaRaw), 'feat-alpha') as TicketFeatureDoc;
  const flakesDoc = validateTicketFeature(JSON.parse(flakesRaw), 'feat-flakes') as TicketFeatureDoc;

  assert.equal(alphaDoc.objective, 'alpha-obj');
  assert.equal(alphaDoc.spec_path, '.scratch/feat-alpha/spec.md');
  assert.equal(alphaDoc.tickets.length, 3);

  const [t1, t2, t3] = alphaDoc.tickets;
  assert.equal(t1.status, 'done');
  assert.equal(t1.owner_try, true);
  assert.equal(t1.live_try, 'Open panel and verify row alignment');
  assert.deepEqual(t1.approved_removals, ['old bar', 'legacy hook']);
  assert.deepEqual(t1.blocked_by, []);
  assert.deepEqual(t1.repairs, ['feat-flakes/01']);
  assert.match(t1.what, /Legacy Blocked by: none \(can start immediately\)/);
  assert.equal(t1.objective, undefined); // inherits feature objective 'alpha-obj'
  assert.equal(t1.acceptance.length, 2);
  assert.equal(t1.acceptance[1].text, 'Wrapped acceptance item spanning two lines cleanly');
  assert.equal(t1.landing?.replay_base, '8ef7617b13b00a34554d9c70c5769834cd46a997');
  assert.equal(t1.landing?.gates, 5);
  assert.deepEqual(t1.accepted, { at: t1.accepted?.at, by: 'lead', flow: 'q0123456789abcdef', verdict: 'All checks green.' });
  assert.equal(t1.comments.length, 1);
  assert.deepEqual(t1.comments[0], { at: '2026-11-20T00:00:00.000Z', author: 'main',
    text: 'Initial note with details\ncontinued on line two.\n\n- nested detail' });

  assert.equal(t2.status, 'done'); // resolved -> done
  assert.equal(t2.role, 'frontend-imp');
  assert.equal(t2.main_review, true);
  assert.equal(t2.objective, 'beta-obj'); // overrides feature objective
  assert.deepEqual(t2.blocked_by, ['feat-alpha/01', 'feat-flakes/01']);
  assert.equal(t2.landing?.commit, 'b6df17f1f59edceb8ad3609565ebd4d5a98a8a3a');
  assert.equal(t2.landing?.gates, 6);
  assert.equal(t2.landing?.at, '2026-11-14T00:00:00.000Z');
  assert.match(t2.what, /\*\*Size:\*\* ~80 lines/);
  assert.ok(t2.comments.some((c) => c.text.includes('90ef78cd, stopgap')));
  assert.ok(t2.comments.some((c) => c.author === 'orchestrator' && c.text === 'Plain bullet without date.'));

  assert.equal(t3.status, 'done');
  assert.deepEqual(t3.blocked_by, ['feat-alpha/01', 'feat-alpha/02']);
  assert.match(t3.what, /OTHER-PROJECT landed/);
  assert.equal(t3.accepted?.by, 'owner');
  assert.equal(t3.comments[0]?.text, 'Plain prose comment without a leading bullet.');

  assert.equal(flakesDoc.objective, 'alpha-obj');
  assert.equal(flakesDoc.tickets.length, 1);
  const [tf1] = flakesDoc.tickets;
  assert.equal(tf1.kind, 'flake-list');
  assert.equal(tf1.live_try, 'Run the flaky suite 20 times.\n\nReview the report afterward.');
  assert.equal(tf1.cases?.length, 3);
  assert.equal(tf1.cases?.[0].case_name, 'flaky test alpha');
  assert.equal(tf1.cases?.[0].test, 'tests/unit/alpha.test.mjs');
  assert.equal(tf1.cases?.[0].flow, 'fa86a2f51f78f4b90');
  assert.equal(tf1.cases?.[0].log, '~/.hud/flows/fa86a2f51f78f4b90.json.gate-1.log');
  assert.equal(tf1.cases?.[1].step, 'test:mjs');
  assert.equal(tf1.cases?.[1].case_name, undefined);
  assert.equal(tf1.cases?.[2].case_name, 'legacy inline flake');
  assert.equal(tf1.cases?.[2].flow, undefined);

  // Confirm JSON facts equal parsed Markdown facts for every ticket.
  for (const [feature, doc, files] of [
    [
      'feat-alpha',
      alphaDoc,
      [
        [1, '.scratch/feat-alpha/issues/01-standard-variant.md'],
        [2, '.scratch/feat-alpha/issues/02-legacy-supervisor-style.md'],
        [3, '.scratch/feat-alpha/issues/03-owner-accepted-prose.md'],
      ],
    ],
    ['feat-flakes', flakesDoc, [[1, '.scratch/feat-flakes/issues/01-gate-flakes.md']]],
  ] as const) {
    for (const [num, rel] of files) {
      const full = join(f.project, rel);
      const iso = fs.statSync(full).mtime.toISOString();
      const parsed = parseMarkdownTicket(fs.readFileSync(full, 'utf8'), num, feature, iso, doc.objective, doc.spec_path);
      assert.ok(!('error' in parsed));
      const record = doc.tickets.find((r) => r.number === num)!;
      assert.deepEqual(diffTicketFacts(parsed.facts, extractTicketFacts(record, doc.objective)), []);
    }
  }

  // Run 2: running migrate twice is a no-op (zero writes, unchanged bytes & mtime).
  const alphaMtimeBefore = fs.statSync(join(f.project, '.hud/tickets/feat-alpha.json')).mtimeMs;
  f.reset();
  const code2 = await main(['tickets', 'migrate', '--cwd', f.project], f.io);
  assert.equal(code2, 0, f.err());
  assert.match(f.out(), /migrated 2 features, 4 tickets \(0 written, 2 unchanged\)/);
  assert.equal(fs.readFileSync(join(f.project, '.hud/tickets/feat-alpha.json'), 'utf8'), alphaRaw);
  assert.equal(fs.statSync(join(f.project, '.hud/tickets/feat-alpha.json')).mtimeMs, alphaMtimeBefore);

  // Run 3: --delete-legacy removes `.scratch/*/issues/*.md` and empty `issues/` dirs, keeps spec.md and prose notes.
  f.reset();
  const code3 = await main(['tickets', 'migrate', '--cwd', f.project, '--delete-legacy'], f.io);
  assert.equal(code3, 0, f.err());
  assert.match(f.out(), /4 legacy files deleted/);
  assert.equal(fs.existsSync(join(f.project, '.scratch/feat-alpha/issues')), false);
  assert.equal(fs.existsSync(join(f.project, '.scratch/feat-flakes/issues')), false);
  assert.equal(fs.readFileSync(join(f.project, '.scratch/feat-alpha/spec.md'), 'utf8'), '# Alpha spec\n\nProse design stays Markdown.\n');
  assert.equal(fs.readFileSync(join(f.project, '.scratch/feat-alpha/notes.md'), 'utf8'), '# Extra notes\n\nKeep this file.\n');
});

test('hud tickets migrate --delete-legacy refuses and deletes nothing when any ticket fails round trip', async (t) => {
  // Case 1: One malformed ticket alongside a valid sibling feature -> refuses, writes nothing, deletes nothing.
  {
    const f = setupEnv(t);
    writeFile(
      join(f.project, '.scratch/good-feat/issues/01-valid.md'),
      '# 01: Valid ticket\n\n**Status:** ready-for-agent\n**Blocked by:** none\n\n**What to build:** Good work.\n\n- [ ] Check\n',
    );
    writeFile(
      join(f.project, '.scratch/bad-feat/issues/01-bad-status.md'),
      '# 01: Broken ticket\n\n**Status:** bogus-unknown-status\n**Blocked by:** none\n\n**What to build:** Bad status.\n\n- [ ] Check\n',
    );

    const code = await main(['tickets', 'migrate', '--cwd', f.project, '--delete-legacy'], f.io);
    assert.notEqual(code, 0);
    assert.match(f.err(), /bad-feat\/01: unknown Status value: bogus-unknown-status/);
    assert.match(f.err(), /migration refused: 1 mismatch\(es\); nothing was written or deleted/);
    assert.ok(fs.existsSync(join(f.project, '.scratch/good-feat/issues/01-valid.md')));
    assert.ok(fs.existsSync(join(f.project, '.scratch/bad-feat/issues/01-bad-status.md')));
    assert.equal(fs.existsSync(join(f.project, '.hud/tickets')), false);
  }

  // Case 2: Simulated round-trip fact loss (renderer drops a fact) -> refuses and deletes nothing.
  {
    const f = setupEnv(t);
    const mdPath = join(f.project, '.scratch/roundtrip-feat/issues/01-check.md');
    writeFile(
      mdPath,
      '# 01: Round trip test\n\n**Status:** ready-for-agent\n**Owner try:** yes\n**Blocked by:** none\n\n**What to build:** Keep every fact.\n\n- [ ] First check\n',
    );
    const res = await migrateTickets(f.project, {
      deleteLegacy: true,
      env: f.env,
      renderTicket: (ticket, feature) => renderTicketBrief({ ...ticket, owner_try: false }, feature),
    });
    assert.equal(res.ok, false);
    assert.equal(res.deleted.length, 0);
    assert.equal(res.written.length, 0);
    assert.ok(res.mismatches.some((m) => m.target === 'roundtrip-feat/01' && m.reason.includes('owner_try mismatch')));
    assert.ok(fs.existsSync(mdPath));
    assert.equal(fs.existsSync(join(f.project, '.hud/tickets/roundtrip-feat.json')), false);
  }

  // Case 3: Pre-existing tampered JSON disagrees with legacy Markdown -> --delete-legacy refuses and deletes nothing.
  {
    const f = setupEnv(t);
    const mdPath = join(f.project, '.scratch/tampered/issues/01-task.md');
    writeFile(
      mdPath,
      '# 01: Original title\n\n**Status:** done\n**Blocked by:** none\n\n**What to build:** Original work.\n\n- [x] Done item\n',
    );
    assert.equal(await main(['tickets', 'migrate', '--cwd', f.project], f.io), 0, f.err());
    const jsonPath = join(f.project, '.hud/tickets/tampered.json');
    const doc = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as TicketFeatureDoc;
    doc.tickets[0].status = 'ready-for-agent';
    fs.writeFileSync(jsonPath, JSON.stringify(doc, null, 2) + '\n');

    f.reset();
    const code = await main(['tickets', 'migrate', '--cwd', f.project, '--delete-legacy'], f.io);
    assert.notEqual(code, 0);
    assert.match(f.err(), /tampered\/01: status mismatch/);
    assert.ok(fs.existsSync(mdPath));
  }
});

test('hud tickets migrate names oversized features and leaves the whole tree alone', async (t) => {
  const f = setupEnv(t);
  for (const [feature, n, length] of [['small', 1, 10], ['oversize', 1, 35_000], ['oversize', 2, 35_000]] as const) {
    writeFile(join(f.project, `.scratch/${feature}/issues/0${n}-task.md`),
      `# 0${n}: Synthetic ticket\n\n**Status:** ready-for-agent\n**Blocked by:** none\n\n**What to build:** ${'x'.repeat(length)}\n`);
  }
  const code = await main(['tickets', 'migrate', '--cwd', f.project, '--delete-legacy'], f.io);
  assert.equal(code, 1);
  assert.match(f.err(), /mismatch oversize: Ticket feature oversize exceeds 64 KiB/);
  assert.equal(fs.existsSync(join(f.project, '.hud/tickets')), false);
  assert.equal(fs.readdirSync(join(f.project, '.scratch/oversize/issues')).length, 2);
  assert.equal(fs.readdirSync(join(f.project, '.scratch/small/issues')).length, 1);
});

test('hud tickets migrate refuses GitHub mirror files', async (t) => {
  const f = setupEnv(t);
  const mirrorFile = join(f.project, '.scratch/gh-feat/issues/10-mirrored.md');
  writeFile(
    mirrorFile,
    '<!-- Generated by hud tickets sync from https://github.com/example/repo/issues/10 -->\n# 10: Mirrored\n\n**Status:** ready-for-agent\n**Blocked by:** none\n',
  );
  const code = await main(['tickets', 'migrate', '--cwd', f.project, '--delete-legacy'], f.io);
  assert.notEqual(code, 0);
  assert.match(f.err(), /GitHub mirror/);
  assert.ok(fs.existsSync(mirrorFile));
  assert.equal(fs.existsSync(join(f.project, '.hud/tickets')), false);
});
