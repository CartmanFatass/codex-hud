import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { buildWorkerArgv } from '../../src/roles/pi-owned/argv.js';
import {
  CONTRACT_MAX_BYTES,
  HELPER_SKILL,
  MAX_CONCURRENT_HELPERS,
  QA_POLL_MS,
  ROLE_TOOLS,
  WORKER_ENTRY,
  readOwnedText,
  readSlotContract,
  roleResource,
  slotPaths,
  validateOwnedDispatch,
  validateSlotContract,
  type ContractContext,
  type SlotContract,
} from '../../src/roles/pi-owned/contracts.js';
import { guardShell, guardTool, type GuardContext } from '../../src/roles/pi-owned/guard.js';
import {
  cacheTtlMs,
  graceDeadline,
  graceExpired,
  reserveHelper,
  settlementDecision,
  warmingDecision,
} from '../../src/roles/pi-owned/lifecycle.js';
import { nextQuestionId, qaDecision, questionMarkdown } from '../../src/roles/pi-owned/qa.js';
import { loadReceipt } from '../../src/roles/job-receipt.js';
import {
  validDispatch,
  launchDispatch,
  reapDispatch,
  type DispatchRole,
  type OwnedDispatchV2,
} from '../../src/roles/pi-dispatch.js';
import { parseDispatchStatus } from '../../src/roles/pi-dispatch-status.js';
import { parseRouting, snapshotPiHelpers, PI_ROLE_DEFAULTS, RoutingError } from '../../src/roles/routing.js';
import { REPO_ROOT } from '../fixtures/paths.js';

const ROLES: DispatchRole[] = ['implementer', 'sonic', 'reviewer', 'architect'];
const publicRole = (role: DispatchRole) => (role === 'implementer' ? 'imp' : role === 'architect' ? 'oracle' : role);
const example = () => fs.readFileSync(join(REPO_ROOT, 'docs/examples/routing.toml'), 'utf8');
function put(file: string, text: string) {
  fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, text, { mode: 0o600 });
}
function fixture(t: TestContext, role: DispatchRole = 'implementer', slot = 'primary') {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hud-owned-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home space ; $(data) ' `meta` Ω");
  const directory = join(home, 'jobs', 'j0123456789abcdef');
  const releaseRoot = join(root, 'release ; $(literal) space');
  const cwd = join(root, "work ' ; $(data)");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cwd, { mode: 0o700 });
  const resources: Record<string, string> = {};
  for (const path of [WORKER_ENTRY, HELPER_SKILL, ...ROLES.map(roleResource)]) {
    const text = `synthetic release resource ${path}\n`;
    put(join(releaseRoot, path), text);
    resources[path] = createHash('sha256').update(text).digest('hex');
  }
  const integration = join(root, 'integration ; $(data).ts');
  put(integration, '// managed by herdr\n// HERDR_INTEGRATION_ID=pi\n// HERDR_INTEGRATION_VERSION=9\n');
  const paths = slotPaths(directory, slot);
  put(paths.brief, 'Synthetic bounded task.\n');
  const context: ContractContext = {
    jobDirectory: directory,
    cwd,
    release: { id: 'release-test', root: releaseRoot, resources },
  };
  const contract: SlotContract = {
    schema: 1,
    job: 'j0123456789abcdef',
    slot,
    role,
    task_dir: directory,
    cwd,
    brief_path: paths.brief,
    output_path: paths.output,
    qa_dir: paths.qa,
    session_dir: paths.sessions,
    session_id: 'synthetic-session-1',
    release: { id: context.release.id, root: releaseRoot },
    role_resource: { path: join(releaseRoot, roleResource(role)), sha256: resources[roleResource(role)]! },
    model: PI_ROLE_DEFAULTS[role].model,
    effort: PI_ROLE_DEFAULTS[role].effort,
    allowed_write_paths: [paths.output],
    ...(slot === 'primary' ? { helpers: snapshotPiHelpers(parseRouting(example())) } : {}),
    herdr_integration: { path: integration, version: 9 },
  };
  const dispatch: OwnedDispatchV2 = {
    contract_version: 2,
    transport: 'hud-owned',
    role,
    launch: 'unsent',
    release: { ...contract.release },
    contract_path: paths.contract,
  };
  const save = () => put(paths.contract, JSON.stringify(contract));
  save();
  return { root, home, directory, context, contract, dispatch, paths, save };
}

test('owned codecs round trip all four roles, receipt v1/v2 and compatible STATUS v1', (t) => {
  for (const role of ROLES) {
    const f = fixture(t, role);
    assert.deepEqual(readSlotContract(f.paths.contract, f.context), f.contract);
    assert.deepEqual(validateOwnedDispatch(f.dispatch, f.context), f.contract);
    const legacy = {
      contract_version: 1,
      role,
      executable: join(f.root, 'old dispatch'),
      reaper: join(f.root, 'old reap'),
      launch: 'acked',
    };
    for (const dispatch of [legacy, f.dispatch]) {
      assert.equal(validDispatch(JSON.parse(JSON.stringify(dispatch)), publicRole(role), f.directory), true);
      put(
        join(f.directory, 'receipt.json'),
        JSON.stringify({
          schema: 1,
          job: f.contract.job,
          role: publicRole(role),
          pi_dispatch: dispatch,
          executor: { kind: 'herdr' },
          binding: { executor: 'herdr', harness: 'pi' },
        })
      );
      assert.deepEqual(loadReceipt(f.home, f.contract.job)?.pi_dispatch, dispatch);
    }
    const status = {
      version: 1,
      task_dir: f.directory,
      slot: 'primary',
      role,
      session_id: 'synthetic',
      model: null,
      thinking: null,
      output_path: f.paths.output,
      output_written: true,
      state: 'closed',
      helper_pending: null,
      settled_at: null,
      idle_deadline_at: null,
      ended_at: null,
      exit_reason: null,
      error: null,
    };
    assert.equal(parseDispatchStatus(status, f.directory, 'primary', role, f.paths.output)?.state, 'closed');
    for (const change of [
      { version: 2 },
      { state: ['closed'] },
      { role: 'imp' },
      { slot: 'sonic-1' },
      { output_path: join(f.root, 'out') },
    ])
      assert.equal(parseDispatchStatus({ ...status, ...change }, f.directory, 'primary', role, f.paths.output), null);
  }
});

test('unknown receipt versions and wrong transport, role, path and release are refused', (t) => {
  const f = fixture(t);
  assert.equal(
    validDispatch(
      {
        contract_version: 1,
        role: 'implementer',
        launch: ['acked'],
        executable: '/synthetic/dispatch',
        reaper: '/synthetic/reap',
      },
      'imp'
    ),
    false
  );
  for (const patch of [
    { contract_version: 99 },
    { contract_version: '2' },
    { role: 'sonic' },
    { transport: 'external' },
    { launch: 'other' },
    { launch: ['acked'] },
    { executable: '/synthetic/bin' },
    { release: { id: '', root: f.context.release.root } },
    { contract_path: join(f.directory, 'contract.json') },
    { contract_path: join(f.root, '.dispatch/primary/contract.json') },
  ])
    assert.equal(validDispatch({ ...f.dispatch, ...patch }, 'imp', f.directory), false, JSON.stringify(patch));
  for (const patch of [
    { schema: 2 },
    { role: 'other' },
    { role: ['reviewer'] },
    { role: { toString: 'reviewer' } },
    { slot: 'sonic-1' },
    { job: 'j0000000000000000' },
    { output_path: join(f.root, 'outside.md') },
    { brief_path: join(f.root, 'outside.md') },
    { allowed_write_paths: [] },
    { allowed_write_paths: [join(f.root, 'outside.md')] },
    { release: { ...f.contract.release, id: 'other' } },
    { release: { ...f.contract.release, root: f.root } },
    { role_resource: { ...f.contract.role_resource, sha256: 'a'.repeat(64) } },
    { session_id: 'bad\nline' },
    { effort: 'invalid' },
    { unexpected: true },
  ])
    assert.throws(() => validateSlotContract({ ...f.contract, ...patch }, f.context), /./, JSON.stringify(patch));
  assert.throws(
    () => validateOwnedDispatch({ ...f.dispatch, release: { ...f.dispatch.release, id: 'other' } }, f.context),
    /release_unavailable/
  );
  put(join(f.context.release.root, roleResource('implementer')), 'tampered resource');
  assert.throws(() => validateSlotContract(f.contract, f.context), /resource_mismatch/);
});

test('slot contracts bind helper slots, output names and prevent nested helpers', (t) => {
  for (const [role, slot] of [
    ['sonic', 'sonic-10'],
    ['reviewer', 'review-3'],
  ] as const) {
    const f = fixture(t, role, slot);
    assert.deepEqual(readSlotContract(f.paths.contract, f.context), f.contract);
    assert.throws(() => validateSlotContract({ ...f.contract, helpers: {} }, f.context), /nested_helpers/);
    assert.throws(
      () => validateSlotContract({ ...f.contract, slot: role === 'sonic' ? 'sonic-11' : 'review-4' }, f.context),
      /slot/
    );
  }
});

test('private regular bounded paths: modes, final/ancestor links, oversized and misplaced contract', (t) => {
  const f = fixture(t);
  fs.chmodSync(f.paths.contract, 0o644);
  assert.throws(() => readSlotContract(f.paths.contract, f.context), /unsafe_path/);
  fs.chmodSync(f.paths.contract, 0o600);
  fs.chmodSync(join(f.directory, '.dispatch'), 0o755);
  assert.throws(() => readSlotContract(f.paths.contract, f.context), /unsafe_path/);
  fs.chmodSync(join(f.directory, '.dispatch'), 0o700);
  fs.writeFileSync(f.paths.contract, 'x'.repeat(CONTRACT_MAX_BYTES + 1));
  assert.throws(() => readSlotContract(f.paths.contract, f.context), /file_too_large/);
  f.save();
  const target = join(f.directory, 'saved.json');
  fs.renameSync(f.paths.contract, target);
  fs.symlinkSync(target, f.paths.contract);
  assert.throws(() => readSlotContract(f.paths.contract, f.context), /unsafe_path/);
  fs.unlinkSync(f.paths.contract);
  f.save();
  const ancestor = join(f.directory, 'linked');
  fs.symlinkSync(join(f.directory, '.dispatch'), ancestor);
  assert.throws(
    () => readOwnedText(join(ancestor, 'primary/contract.json'), CONTRACT_MAX_BYTES, f.directory),
    /unsafe_path/
  );
  assert.throws(() => readSlotContract(target, f.context), /contract_path/);
  fs.symlinkSync(join(f.root, 'outside'), f.paths.output);
  assert.throws(() => validateSlotContract(f.contract, f.context), /unsafe_path/);
});

for (const role of ROLES)
  test(`argv exact array for ${role}, preserving path characters`, (t) => {
    const f = fixture(t, role);
    const argv = buildWorkerArgv(readSlotContract(f.paths.contract, f.context), 'job-primary', 'w1:p1');
    assert.equal(Array.isArray(argv), true);
    assert.deepEqual(argv, [
      'agent',
      'start',
      'job-primary',
      '--kind',
      'pi',
      '--pane',
      'w1:p1',
      '--timeout',
      '30000',
      '--',
      '-ne',
      '-ns',
      '-np',
      '--no-themes',
      '--no-mcp',
      '--no-approve',
      '-e',
      join(f.context.release.root, WORKER_ENTRY),
      '-e',
      f.contract.herdr_integration.path,
      '--hud-role-contract',
      f.paths.contract,
      '--hud-role-file',
      f.contract.role_resource.path,
      '--model',
      f.contract.model,
      '--thinking',
      f.contract.effort,
      '--tools',
      ROLE_TOOLS[role],
      '--session-dir',
      f.paths.sessions,
      '--session-id',
      'synthetic-session-1',
      '--tui-mode',
      'regular',
      ...(role === 'implementer' ? ['--skill', join(f.context.release.root, HELPER_SKILL)] : []),
    ]);
    assert.throws(
      () => buildWorkerArgv({ ...f.contract, herdr_integration: { path: '', version: 9 } }, 'job', 'pane'),
      /herdr_pi_integration_missing/
    );
    assert.throws(
      () =>
        validateSlotContract(
          { ...f.contract, herdr_integration: { ...f.contract.herdr_integration, version: 8 } },
          f.context
        ),
      /herdr_pi_integration_missing/
    );
  });

test('routing defaults, partial overrides, mixed presets and pinned parent snapshot', () => {
  const withoutHelpers = example().split('# Internal pi helpers')[0]!;
  const routing = parseRouting(withoutHelpers);
  assert.deepEqual(routing.piHelpers, { sonic: PI_ROLE_DEFAULTS.sonic, reviewer: PI_ROLE_DEFAULTS.reviewer });
  assert.equal(routing.presets['pi-build']?.roles.reviewer, 'claude-opus');
  const partial = parseRouting(
    withoutHelpers + '\n[pi_helpers.sonic]\neffort="low"\n[pi_helpers.reviewer]\nmodel="synthetic/review"\n'
  );
  assert.deepEqual(partial.piHelpers, {
    sonic: { model: PI_ROLE_DEFAULTS.sonic.model, effort: 'low' },
    reviewer: { model: 'synthetic/review', effort: 'xhigh' },
  });
  const snapshot = snapshotPiHelpers(partial);
  (partial.piHelpers.sonic as { effort: string }).effort = 'high';
  (partial.piHelpers.reviewer as { model: string }).model = 'changed';
  assert.equal(snapshot.sonic.effort, 'low');
  assert.equal(snapshot.reviewer.model, 'synthetic/review');
  assert.equal(Object.isFrozen(snapshot.sonic), true);
});

test('routing rejects unknown helper keys and unsupported efforts with named fields', () => {
  const base = example().split('# Internal pi helpers')[0]!;
  for (const [suffix, code, field] of [
    ['[pi_helpers.architect]\nmodel="x"', 'unknown_key', 'pi_helpers.architect'],
    ['[pi_helpers.sonic]\nexecutor="herdr"', 'unknown_key', 'pi_helpers.sonic.executor'],
    ['[pi_helpers.sonic]\neffort="xhigh"', 'invalid_value', 'pi_helpers.sonic.effort'],
    ['[pi_helpers.reviewer]\neffort="turbo"', 'invalid_value', 'pi_helpers.reviewer.effort'],
    ['[pi_helpers.reviewer]\nmodel=1', 'invalid_type', 'pi_helpers.reviewer.model'],
  ])
    assert.throws(
      () => parseRouting(base + '\n' + suffix),
      (error) => error instanceof RoutingError && error.code === code && error.field === field
    );
});

test('QA timeout fake clock: 1199 s waits, exactly 1200 s instructs default, cancellation differs', () => {
  assert.deepEqual(qaDecision(100, 100 + 1199_000, false), { kind: 'waiting' });
  assert.deepEqual(qaDecision(100, 100 + 1200_000, false), {
    kind: 'timeout',
    text: 'proceed with your proposed default',
  });
  assert.deepEqual(qaDecision(0, 1200_000, true, 'answer'), { kind: 'interrupted' });
  assert.deepEqual(qaDecision(0, 2000, false, ' answer '), { kind: 'answered', text: 'answer' });
  assert.equal(QA_POLL_MS, 2000);
  assert.equal(nextQuestionId(['q1.md', 'q4.answer.md', 'q2.md']), 'q5');
  assert.equal(nextQuestionId([], 8), 'q9');
  assert.throws(() => nextQuestionId(['q9999.answer.md']), /qa_exhausted/);
  const md = questionMarkdown(
    { question: 'Which?', options: ['A', 'B'], proposedDefault: 'A', context: 'Synthetic' },
    'q1'
  );
  for (const text of ['Which?', '- A', 'Proposed default', 'Synthetic', 'q1.answer.md']) assert.ok(md.includes(text));
});

test('helper limits consume reservations, refuse reviewer round 4, sonic call 11 and concurrent work', () => {
  let state = { sonicCalls: 0, reviewRounds: 0, active: false };
  for (let n = 0; n < 3; n++) state = { ...reserveHelper('implementer', 'primary', 'reviewer', state), active: false };
  assert.throws(() => reserveHelper('implementer', 'primary', 'reviewer', state), /helper_limit/);
  for (let n = 0; n < 10; n++) state = { ...reserveHelper('implementer', 'primary', 'sonic', state), active: false };
  assert.throws(() => reserveHelper('implementer', 'primary', 'sonic', state), /helper_limit/);
  assert.throws(
    () => reserveHelper('implementer', 'primary', 'reviewer', { sonicCalls: 0, reviewRounds: 0, active: true }),
    /helper_busy/
  );
  assert.throws(
    () => reserveHelper('sonic', 'primary', 'reviewer', { sonicCalls: 0, reviewRounds: 0, active: false }),
    /helper_ineligible/
  );
  assert.equal(MAX_CONCURRENT_HELPERS, 1);
});

test('settlement, fixed grace and warming retain generation/output/QA/helper fences', () => {
  const facts = {
    generation: 1,
    expectedGeneration: 1,
    settled: true,
    idle: true,
    pendingMessages: false,
    helperPending: false,
    questions: 0,
    aborted: false,
    error: false,
    outputBefore: 'old',
    outputAfter: 'new',
  };
  assert.equal(settlementDecision(facts), 'ready');
  for (const patch of [
    { generation: 2 },
    { settled: false },
    { idle: false },
    { pendingMessages: true },
    { helperPending: true },
    { questions: 2 },
  ])
    assert.equal(settlementDecision({ ...facts, ...patch }), 'wait');
  for (const patch of [{ aborted: true }, { error: true }, { outputAfter: null }, { outputAfter: 'old' }])
    assert.equal(settlementDecision({ ...facts, ...patch }), 'failed');
  assert.equal(cacheTtlMs(undefined), 0);
  assert.equal(cacheTtlMs(60), 60000);
  assert.equal(graceDeadline(1000, 60000, 2000), 2000);
  assert.equal(graceExpired(1999, 2000, 1, 1), false);
  assert.equal(graceExpired(2000, 2000, 1, 1), true);
  assert.equal(graceExpired(3000, 2000, 2, 1), false);
  const warm = {
    closing: false,
    failed: false,
    disabled: false,
    spentUsd: 0.1,
    estimatedUsd: 0.1,
    helperPending: false,
    settled: false,
  };
  assert.equal(warmingDecision(warm), 'native');
  assert.equal(warmingDecision({ ...warm, settled: true }), 'stop');
  assert.equal(warmingDecision({ ...warm, helperPending: true, settled: true }), 'warm');
  for (const patch of [
    { closing: true },
    { failed: true },
    { disabled: true },
    { spentUsd: 0.5 },
    { estimatedUsd: 0.41 },
    { estimatedUsd: NaN },
  ])
    assert.equal(warmingDecision({ ...warm, ...patch }), 'stop');
});

test('read-only guard allows exact report and QA/temp exceptions, refuses worktree edits and links', (t) => {
  const f = fixture(t, 'reviewer');
  const context: GuardContext = {
    role: 'reviewer',
    cwd: f.context.cwd,
    allowedWritePaths: [f.paths.output],
    qaDirectory: f.paths.qa,
    temporaryDirectory: join(f.directory, 'scratch'),
  };
  assert.equal(guardTool(context, 'write', { path: f.paths.output }).allowed, true);
  assert.equal(guardTool(context, 'write', { path: join(f.paths.qa, 'q1.md') }).allowed, true);
  assert.equal(guardTool(context, 'write', { path: join(f.directory, 'scratch/temp') }).allowed, true);
  assert.equal(guardTool(context, 'write', { path: join(f.directory, 'report.md.extra') }).allowed, false);
  assert.equal(guardTool(context, 'edit', { path: f.paths.output }).allowed, false);
  assert.equal(guardTool(context, 'write', { path: 'src/code.ts' }).allowed, false);
  fs.symlinkSync(join(f.root, 'outside'), f.paths.output);
  assert.equal(guardTool(context, 'write', { path: f.paths.output }).allowed, false);
  assert.equal(guardTool({ ...context, role: 'implementer' }, 'edit', { path: 'src/code.ts' }).allowed, true);
});

test('shell guard permits simple quoted > and refuses redirects and conservative complex shell cases', () => {
  for (const prefix of ['', 'env ', 'MODE="x;y" ', 'env MODE="x;y" ', "env MODE='x|y' ", 'MODE="x(y)" env ']) {
    for (const wrapper of ['', 'xargs -0 ', 'xargs -n 1 ', 'xargs -I "x;y" ', 'xargs -E "" ', "xargs -E '' "]) {
      for (const command of ['rm file', 'touch file']) {
        const combined = prefix + wrapper + command;
        assert.equal(guardShell(combined).allowed, false, combined);
      }
      const safe = prefix + wrapper + 'rg "a > b" src';
      assert.equal(guardShell(safe).allowed, true, safe);
    }
  }
  for (const command of [
    "rg 'a > b' src",
    "node -e 'x => x > 1'",
    'echo "a >> b"',
    'git diff --check',
    'git status',
    'git stash list',
    'git worktree list',
    'echo ok > /dev/null',
    'echo ok 2>&1',
  ])
    assert.equal(guardShell(command).allowed, true, command);
  for (const command of [
    'git add -A',
    'git -C "work space" reset --hard',
    'git stash',
    'git branch -D topic',
    'git tag new-tag',
    'git worktree add somewhere',
    'git config user.name Synthetic',
    "echo 'git add -A'",
    'sed -i x file',
    'rm file',
    'env A=b touch file',
    'xargs -0 rm',
    'xargs -n 1 touch',
    'xargs -I {} rm {}',
    'MODE=test xargs -0 rm',
    'env MODE=test xargs -n 1 touch',
    'env MODE="a;b" rm file',
    "env MODE='a|b' xargs -0 rm",
    'env MODE="(test)" touch file',
    'xargs -I "a;b" rm file',
    "MODE='a;b' env NEXT='c|d' xargs -I 'e;f' rm file",
    'xargs -E "" rm file',
    "env MODE='a;b' xargs -E '' touch file",
    'cat file | tee out',
    'npm install x',
    'npm i dependency',
    'pnpm i',
    'bun install',
    'pacman install dependency',
    'dnf install dependency',
    'yum update',
    'echo "a > b" > out',
    'echo ok >> out',
    'echo ok &> out',
    'echo "$(echo \'a > b\')"',
    "echo 'a > b'\ntrue",
    '[[ a > b ]]',
    "echo $'a > b'",
  ])
    assert.equal(guardShell(command).allowed, false, command);
});

test('shell guard bounds repeated xargs options without executing their contents', () => {
  const module = new URL('../../src/roles/pi-owned/guard.js', import.meta.url).href;
  const code = `import {guardShell} from ${JSON.stringify(module)};
    for (const n of [40, 400, 4000]) {
      if (!guardShell('xargs ' + '-I '.repeat(n) + 'echo').allowed) process.exit(1);
    }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { timeout: 2000, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test('all shipped role/skill resources stay public-safe and use only owned capabilities', () => {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(join(REPO_ROOT, directory), { withFileTypes: true })) {
      const relative = join(directory, entry.name);
      if (entry.isDirectory()) visit(relative);
      else {
        assert.equal(entry.isFile(), true, relative);
        files.push(relative);
      }
    }
  };
  visit('integrations/pi/roles');
  visit('integrations/pi/skills');
  assert.deepEqual(files.sort(), [...ROLES.map(roleResource), HELPER_SKILL].sort());
  const allowedTools = new Set(Object.values(ROLE_TOOLS).flatMap((list) => list.split(',')));
  for (const relative of files) {
    const text = fs.readFileSync(join(REPO_ROOT, relative), 'utf8');
    assert.doesNotMatch(text, /\/(?:home|Users|root)\/|[A-Z]:\\Users\\|~\//i, relative);
    assert.doesNotMatch(
      text,
      /Fishpref|Jacob|fires|pi-role-call|pi-dispatch|pi-role-reap|jev-ask|rate_helper|ledger|ratings?|DeepSeek search|search_web|mcp__|lens|lsp|ast-grep|PI_ROLE_BUNDLE|--role-bundle/i,
      relative
    );
    assert.doesNotMatch(
      text,
      /gpt-|claude-opus|deepseek|mistral\/|effort\s*[:=]|thinking\s*[:=]\s*['"](?:xhigh|max)/i,
      relative
    );
    for (const tool of text.matchAll(/\b(?:call_[a-z_]+|ask_[a-z_]+)\b/g))
      assert.ok(allowedTools.has(tool[0]), `${relative}: ${tool[0]}`);
  }
  assert.match(fs.readFileSync(join(REPO_ROOT, roleResource('reviewer')), 'utf8'), /Verdict: changes-required/);
});

test('PR1 has no production selection: launch code has no owned module import, legacy transport refuses v2', async (t) => {
  const f = fixture(t);
  for (const relative of ['src/roles/facade.ts', 'src/roles/pi-dispatch.ts', 'src/roles/job-receipt.ts'])
    assert.doesNotMatch(
      fs.readFileSync(join(REPO_ROOT, relative), 'utf8'),
      /(?:from\s*|import\s*\()['"][^'"]*pi-owned\//
    );
  assert.throws(
    () => launchDispatch(f.dispatch, f.directory, f.context.cwd, null, null, {}),
    /owned_dispatch_unavailable/
  );
  assert.throws(() => reapDispatch(f.dispatch, f.directory, {}), /owned_dispatch_unavailable/);
});
