import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import { sourceFixture, runtimeRow } from './b10d-fixture.mjs';
import { waitUntil } from './b10d-harness.mjs';
const preload = new URL('./b10d-legacy-preload.mjs', import.meta.url).href;
async function production(f, entry, baseline, epoch, rootFile, artifacts) {
  const trace = join(artifacts, entry + (baseline ? '-baseline' : '-worker') + '.jsonl');
  writeFileSync(trace, '');
  let file = resolve(entry === 'bar' ? 'dist/index.js' : 'dist/tree-page.js');
  if (baseline) {
    const source = execFileSync('git', ['show', '6fcf08a:src/' + (entry === 'bar' ? 'index.ts' : 'tree-page.ts')], {
      encoding: 'utf8',
    });
    const js = ts
      .transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
      .outputText.replace(/from ['"]\.\/(.*?)['"]/g, (_, p) => 'from ' + JSON.stringify(resolve('dist', p)));
    file = join(artifacts, entry + '-baseline.mjs');
    writeFileSync(file, js);
  }
  const child = spawn(process.execPath, ['--import', preload, file], {
    cwd: f.sourceRoot,
    env: {
      TZ: 'UTC',
      PATH: '/usr/bin:/bin',
      HOME: f.home,
      HUD_HOME: f.home,
      CODEX_HOME: f.sourceRoot,
      CODEX_HUD_CWD: f.legacyProject ?? '/synthetic/project',
      CODEX_HUD_SETTINGS_PATH: join(f.home, 'settings.json'),
      TERM: 'xterm-256color',
      B10D_LEGACY_EPOCH: String(epoch),
      B10D_LEGACY_ROOT: rootFile,
      B10D_LEGACY_TRACE: trace,
    },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (b) => (stderr = (stderr + b).slice(-10000)));
  const done = once(child, 'exit');
  const rows = () => readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await done;
    clearTimeout(timer);
  };
  try {
    await waitUntil(() => rows().some((r) => r.tree.totalCount >= 2 && (baseline || r.view)), 20000);
    if (!baseline)
      await waitUntil(() => rows().some((r) => r.client && !r.view) && rows().some((r) => r.client && r.view), 20000);
    await waitUntil(() => rows().some((r) => r.tree.totalCount >= 2 && r.legacy.git.isGitRepo), 20000);
    if (entry === 'panel')
      await waitUntil(() => existsSync(trace + '.panel') && readFileSync(trace + '.panel', 'utf8').trim(), 20000);
    const output = rows();
    output.actualPanel =
      entry === 'panel'
        ? readFileSync(trace + '.panel', 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map(JSON.parse)
        : [];
    return output;
  } catch (e) {
    throw new Error(
      JSON.stringify({
        entry,
        baseline,
        rows: rows()
          .slice(-3)
          .map((r) => ({ nodes: r.tree.totalCount, root: r.tree.rootId, client: r.client, view: r.view })),
        error: String(e),
        stderr,
      })
    );
  } finally {
    await close();
  }
}
for (const entry of ['bar', 'panel'])
  test(`B10D ${entry} legacy tree and frame bytes match6fcf08a with a ledger and initializing/delivered worker`, async (t) => {
    const f = await sourceFixture(1, 1),
      artifacts = mkdtempSync(join(tmpdir(), 'hud-b10d-parity-'));
    t.after(() => {
      f.cleanup();
      rmSync(artifacts, { recursive: true, force: true });
    });
    const project = join(f.home, 'legacy-project');
    mkdirSync(project);
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', project]);
    writeFileSync(join(project, 'tracked.txt'), 'synthetic original\n');
    execFileSync('git', ['-C', project, 'add', 'tracked.txt']);
    execFileSync('git', [
      '-C',
      project,
      '-c',
      'user.name=Synthetic',
      '-c',
      'user.email=synthetic@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'Synthetic fixture',
    ]);
    writeFileSync(join(project, 'tracked.txt'), 'synthetic changed\n');
    writeFileSync(join(project, 'untracked.txt'), 'synthetic new\n');
    f.legacyProject = project;
    const epoch = Date.now(),
      dir = join(f.sourceRoot, 'sessions', '2026', '11', '03');
    mkdirSync(dir, { recursive: true });
    const ids = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
    ];
    const rootFile = join(dir, 'rollout-2026-11-03T00-00-00-' + ids[0] + '.jsonl');
    ids.forEach((id, i) =>
      writeFileSync(
        join(dir, 'rollout-2026-11-03T00-00-00-' + id + '.jsonl'),
        JSON.stringify({
          type: 'session_meta',
          timestamp: new Date(epoch - 5000).toISOString(),
          payload: {
            id,
            timestamp: new Date(epoch - 5000).toISOString(),
            cwd: i ? '/synthetic/child' : project,
            cli_version: 'synthetic',
            ...(i
              ? { parent_thread_id: ids[i - 1], agent_nickname: i === 1 ? 'Legacy model child' : 'Nested child' }
              : {}),
            model: 'synthetic-model',
            effort: 'high',
          },
        }) +
          '\n' +
          runtimeRow('event_msg', { type: 'task_started' }, 1)
      )
    );
    writeFileSync(
      join(f.home, 'settings.json'),
      JSON.stringify({
        briefing: 'off',
        briefAgents: false,
        briefMain: false,
        agentProgress: false,
        agentLabels: false,
        resultDigest: false,
        notify: false,
        changesPane: 'open',
      })
    );
    const baseline = await production(f, entry, true, epoch, rootFile, artifacts),
      actual = await production(f, entry, false, epoch, rootFile, artifacts);
    const expected = baseline.find((r) => r.tree.totalCount >= 2);
    assert.ok(expected);
    for (const phase of [false, true]) {
      const rows = actual.filter((r) => r.client && r.view === phase && r.tree.totalCount >= 2);
      assert.ok(rows.length, 'legacy must remain visible in both worker phases');
      const row = rows.at(-1);
      const matching = baseline.find(
        (b) => b.tree.totalCount >= 2 && b.legacy.git.isGitRepo === row.legacy.git.isGitRepo
      );
      assert.ok(matching);
      assert.deepEqual(row.tree, matching.tree);
      assert.deepEqual(row.legacy, matching.legacy);
      assert.deepEqual(row[entry], matching[entry]);
    }
    if (entry === 'panel') {
      const expectedPanel = baseline.actualPanel.at(-1),
        actualPanel = actual.actualPanel.at(-1);
      assert.equal(expectedPanel.files.length, 2);
      assert.deepEqual(actualPanel.files, expectedPanel.files);
      assert.deepEqual(actualPanel.lines, expectedPanel.lines);
    }
    console.log(
      JSON.stringify({
        entry,
        legacyNodes: expected.tree.totalCount,
        phases: actual.map((r) => ({ client: r.client, view: r.view, nodes: r.tree.totalCount })),
        baseline:
          'git show6fcf08a + unchanged legacy algorithms; fixed clock/frame context; universal bar modules separately qualified',
      })
    );
  });
