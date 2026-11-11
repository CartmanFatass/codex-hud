#!/usr/bin/env node
/** E04–E06. Opt-in, synthetic only. Real clean packer and immutable artifact; no live herdr/provider. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, spawnSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const node = fs.realpathSync(process.execPath);
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
function put(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
}
const load = (p) => import(pathToFileURL(p).href);
async function until(body, ms = 10000) {
  const end = performance.now() + ms;
  while (!body()) {
    if (performance.now() > end) throw Error('rehearsal_condition_deadline');
    await pause(20);
  }
}
function proc(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ');
    return {
      pid,
      ppid: Number(stat[1]),
      rssKiB: Number(/^VmRSS:\s+(\d+)/m.exec(s)?.[1] ?? 0),
      ticks: Number(stat[11]) + Number(stat[12]),
      voluntary: Number(/^voluntary_ctxt_switches:\s+(\d+)/m.exec(s)?.[1] ?? 0),
      nonvoluntary: Number(/^nonvoluntary_ctxt_switches:\s+(\d+)/m.exec(s)?.[1] ?? 0),
      argv: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean),
      io: Object.fromEntries(
        fs
          .readFileSync(`/proc/${pid}/io`, 'utf8')
          .trim()
          .split('\n')
          .map((line) => {
            const [key, value] = line.split(':');
            return [key, Number(value.trim())];
          })
      ),
    };
  } catch {
    return null;
  }
}
const stats = (v) => {
  const a = [...v].sort((a, b) => a - b);
  return {
    n: a.length,
    p50: a[Math.ceil(a.length * 0.5) - 1],
    p95: a[Math.ceil(a.length * 0.95) - 1],
    p99: a[Math.ceil(a.length * 0.99) - 1],
    max: a.at(-1),
  };
};
async function ownedFixture({ root, release, env, piPackage, fakeDir, mode }) {
  const directory = path.join(root, 'home/jobs/j0123456789abcdef'),
    cwd = path.join(root, 'work space');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cwd, { mode: 0o700 });
  const { loadWorkerRelease } = await load(path.join(release, 'dist/roles/pi-owned/release.js'));
  const pinned = await loadWorkerRelease();
  const context = { jobDirectory: directory, cwd, release: pinned };
  const { slotPaths, roleResource } = await load(path.join(release, 'dist/roles/pi-owned/contracts.js'));
  const { PI_ROLE_DEFAULTS } = await load(path.join(release, 'dist/roles/routing.js'));
  const { readProcess } = await load(path.join(release, 'dist/core/run/process.js'));
  const { launchOwned } = await load(path.join(release, 'dist/roles/pi-owned/launch.js'));
  const { reapOwned } = await load(path.join(release, 'dist/roles/pi-owned/reap.js'));
  const { runCommand } = await load(path.join(release, 'dist/roles/herdr-run.js'));
  const integration = path.join(root, 'herdr-reporter.ts');
  put(
    integration,
    `// managed by herdr\n// HERDR_INTEGRATION_ID=pi\n// HERDR_INTEGRATION_VERSION=9\nimport fs from 'node:fs';\nexport default function reporter(pi) { pi.on('session_start',()=>fs.appendFileSync(${JSON.stringify(path.join(root, 'reporter-events'))},'session_start\\n',{mode:0o600})); }\n`
  );
  const paths = slotPaths(directory, 'primary');
  put(path.join(directory, 'sonic-source.md'), 'Synthetic nested helper request.\n');
  put(paths.brief, 'Synthetic release rehearsal; no model task.\n');
  const contract = {
    schema: 1,
    job: 'j0123456789abcdef',
    slot: 'primary',
    role: 'implementer',
    task_dir: directory,
    cwd,
    brief_path: paths.brief,
    output_path: paths.output,
    qa_dir: paths.qa,
    session_dir: paths.sessions,
    session_id: 'synthetic-primary',
    release: { id: pinned.id, root: release },
    role_resource: {
      path: path.join(release, roleResource('implementer')),
      sha256: pinned.resources[roleResource('implementer')],
    },
    model: PI_ROLE_DEFAULTS.implementer.model,
    effort: PI_ROLE_DEFAULTS.implementer.effort,
    allowed_write_paths: [paths.output],
    helpers: { sonic: { ...PI_ROLE_DEFAULTS.sonic }, reviewer: { ...PI_ROLE_DEFAULTS.reviewer } },
    herdr_integration: { path: integration, version: 9 },
  };
  put(paths.contract, contract);
  const indexPath = path.join(root, 'home/jobs/index/key.json'),
    associationPath = path.join(root, 'home/assoc/j0123456789abcdef.json');
  for (const p of [path.join(directory, 'receipt.json'), indexPath, associationPath]) put(p, { job: contract.job });
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { mode: 0o700 });
  fs.symlinkSync(path.join(fakeDir, 'pi-owned-herdr.mjs'), path.join(bin, 'herdr'));
  fs.chmodSync(path.join(fakeDir, 'pi-owned-herdr.mjs'), 0o700);
  // Use the actual installed executable for preflight; no parallel pi stub.
  fs.symlinkSync(path.join(piPackage.root, 'dist/cli.js'), path.join(bin, 'pi'));
  const socketPath = path.join(root, 'socket'),
    stateFile = path.join(root, 'herdr-state.json');
  put(stateFile, { n: 0, tabs: [], panes: [], agents: [], mode, counts: {} });
  const childEnv = {
    ...env,
    HOME: path.join(root, 'home'),
    HUD_HOME: path.join(root, 'home'),
    CODEX_HOME: path.join(root, 'home/codex'),
    CLAUDE_CONFIG_DIR: path.join(root, 'home/claude'),
    PATH: bin + path.delimiter + env.PATH,
    OWNED_PROCESS_MODULE: pathToFileURL(path.join(release, 'dist/core/run/process.js')).href,
    OWNED_HELPERS_MODULE: pathToFileURL(path.join(release, 'dist/roles/pi-owned/helpers.js')).href,
    OWNED_PI_PACKAGE: piPackage.root,
  };
  const server = fork(
    path.join(fakeDir, 'pi-owned-herdr.mjs'),
    ['--server', socketPath, root, directory, integration],
    { env: childEnv, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
  );
  let errors = '';
  server.stderr.on('data', (b) => (errors += b));
  const serverClosed = once(server, 'close');
  const readyTimer = setTimeout(() => server.kill('SIGKILL'), 15000);
  try {
    await Promise.race([
      once(server, 'message'),
      serverClosed.then(() => {
        throw Error('fixture_server_closed_before_ready: ' + errors);
      }),
    ]);
  } finally {
    clearTimeout(readyTimer);
  }
  const options = {
    endpoint: { socketPath, server: readProcess(server.pid).stamp },
    env: childEnv,
    callerTabId: 'caller-tab',
    indexPath,
    associationPath,
    budgetMs: 20000,
  };
  let closed = false;
  return {
    root,
    directory,
    integration,
    server,
    context,
    options,
    state: () => read(stateFile),
    mode: (mode) => {
      const s = read(stateFile);
      s.mode = mode;
      put(stateFile, s);
    },
    journal: () => read(path.join(directory, '.dispatch/primary/launch.json')),
    launch: async () => {
      const result = await launchOwned(context, options);
      put(path.join(root, 'launch-result.json'), result);
      return result;
    },
    run: (args) =>
      runCommand(path.join(bin, 'herdr'), args, { ...childEnv, HERDR_SOCKET_PATH: socketPath }, { budgetMs: 10000 }),
    close: async () => {
      if (closed) return;
      closed = true;
      const before = performance.now();
      const result = await reapOwned(context, { ...options, budgetMs: 10000, graceMs: 1000 });
      put(path.join(root, 'cleanup-result.json'), { result, ms: performance.now() - before, stderr: errors });
      if (server.exitCode === null) {
        const done = once(server, 'exit');
        server.kill('SIGTERM');
        await done;
      }
    },
  };
}
export async function rehearse(out, clients = {}) {
  if (!path.isAbsolute(out) || fs.existsSync(out)) throw Error('new_absolute_output_directory_required');
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const home = path.join(out, 'home with spaces'),
    prefix = path.join(home, 'runtime prefix'),
    hudHome = path.join(home, 'hud'),
    shimDir = path.join(home, 'local bin');
  for (const p of [home, prefix, hudHome, path.join(home, '.claude'), path.join(home, 'codex')])
    fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  const transport = Object.fromEntries(
    ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']
      .filter((k) => typeof process.env[k] === 'string')
      .map((k) => [k, process.env[k]])
  );
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    HUD_HOME: hudHome,
    CODEX_HOME: path.join(home, 'codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    TMPDIR: out,
    LANG: 'C.UTF-8',
    CI: '1',
    JITI_FS_CACHE: '0',
  };
  // The parent and every spawned process use this isolated authority context, not inherited owner state.
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, env);
  const report = {
    status: 'RUNNING',
    host: { hostname: os.hostname(), kernel: os.release(), cpus: os.cpus().length, node: process.version },
    packerTransportVariableNames: Object.keys(transport),
    commands: [],
    smoke: [],
    cost: {},
    steps: [],
  };
  const clone = path.join(out, 'disposable checkout');
  const cleanup = [];
  const run = (exe, args, input, timeout = 240000, cwd = home) => {
    const at = performance.now();
    const r = spawnSync(exe, args, {
      env,
      cwd,
      input,
      encoding: 'utf8',
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      killSignal: 'SIGKILL',
    });
    report.commands.push({
      command: [exe, ...args],
      cwd,
      code: r.status,
      signal: r.signal,
      error: r.error?.code ?? null,
      ms: performance.now() - at,
      stdout: r.stdout,
      stderr: r.stderr,
    });
    assert.equal(r.status, 0, `${exe} ${args.join(' ')}: ${r.stderr}`);
    return { text: r.stdout, ms: performance.now() - at };
  };
  const command = (entry, args) => JSON.parse(run(node, [entry, ...args]).text);
  try {
    const sha = run('/usr/bin/git', ['-C', repo, 'rev-parse', 'HEAD']).text.trim();
    report.sha = sha;
    run('/usr/bin/git', ['clone', '--local', repo, clone], undefined, 120000);
    const changed = run('/usr/bin/git', ['-C', repo, 'diff', 'HEAD', '--name-only', '-z'])
      .text.split('\0')
      .filter(Boolean);
    for (const name of changed) {
      const source = path.join(repo, name);
      if (!fs.existsSync(source)) continue;
      fs.mkdirSync(path.dirname(path.join(clone, name)), { recursive: true });
      fs.copyFileSync(source, path.join(clone, name));
    }
    const newShipped = ['scripts/codex-activation.mjs', 'scripts/runtime-package/codex.mjs'];
    for (const name of newShipped) {
      fs.mkdirSync(path.dirname(path.join(clone, name)), { recursive: true });
      fs.copyFileSync(path.join(repo, name), path.join(clone, name));
    }
    run('/usr/bin/git', ['-C', clone, 'add', '-N', ...newShipped]);
    // Historical repository tracks part of node_modules; remove only this disposable clone's independent checkout copy.
    fs.rmSync(path.join(clone, 'node_modules'), { recursive: true, force: true });
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(clone, 'node_modules'), 'dir'); // tsc only; packer npm ci is isolated.
    async function build(label) {
      const child = spawn(node, [path.join(clone, 'scripts/pack-runtime.mjs')], {
        env: { ...env, ...transport },
        cwd: clone,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let text = '';
      child.stdout.on('data', (b) => (text += b));
      child.stderr.on('data', (b) => (text += b));
      const timer = setTimeout(() => child.kill('SIGKILL'), 240000);
      const [code] = await once(child, 'close');
      clearTimeout(timer);
      put(path.join(out, `build-${label}.log`), text + `\nexit=${code}\n`);
      assert.equal(code, 0, text.slice(-4000));
      const receiptPath = /Runtime build receipt: (.+)/.exec(text)?.[1];
      assert.ok(receiptPath);
      const built = read(receiptPath);
      const dest = path.join(out, `build ${label}`);
      fs.renameSync(path.dirname(receiptPath), dest);
      const cacheEntries = fs.readdirSync(path.join(dest, 'npm-cache'), { recursive: true }).length;
      // Private cache file sizes are the measured download/cache bytes, not an estimate from package size.
      const bytes = (p) =>
        fs
          .readdirSync(p, { withFileTypes: true })
          .reduce(
            (n, e) => n + (e.isDirectory() ? bytes(path.join(p, e.name)) : fs.statSync(path.join(p, e.name)).size),
            0
          );
      report.steps.push({
        name: `clean build ${label}`,
        digest: built.manifestDigest,
        entries: built.entries,
        cacheBytes: bytes(path.join(dest, 'npm-cache')),
        cacheEntries,
      });
      return { bundle: path.join(dest, 'runtime'), digest: built.manifestDigest };
    }
    const a = await build('N');
    const pkg = read(path.join(clone, 'package.json'));
    pkg.version = '0.1.0-rehearsal.2';
    put(path.join(clone, 'package.json'), pkg);
    const b = await build('N+1');
    assert.notEqual(a.digest, b.digest);
    // Relocate BOTH clean artifacts before installation; no checkout-relative executable/import survives.
    const relocated = path.join(out, 'relocated artifacts with spaces');
    fs.mkdirSync(relocated, { mode: 0o700 });
    for (const [name, r] of [
      ['N', a],
      ['N+1', b],
    ]) {
      const p = path.join(relocated, name);
      fs.renameSync(r.bundle, p);
      r.bundle = p;
    }
    const bootstrap = path.join(a.bundle, 'activate-runtime.mjs');
    function stage(r) {
      const entry = path.join(r.bundle, 'install-runtime.mjs');
      const p = command(entry, ['preview', '--prefix', prefix, '--stage-only', 'yes']);
      return command(entry, ['stage', '--prefix', prefix, '--expect', p.planDigest]);
    }
    stage(a);
    stage(b);
    // Mutation anchor: never substitute a decoy deletion. This is the actual checkout used by both packer runs.
    fs.rmSync(clone, { recursive: true, force: true }); // DELETE_SOURCE_CHECKOUT
    assert.equal(fs.existsSync(clone), false, 'deleted-checkout step must actually remove build source');
    report.steps.push({ name: 'E05 relocation and deleted actual build checkout', status: 'PASS' });
    const ar = path.join(prefix, 'releases', a.digest),
      br = path.join(prefix, 'releases', b.digest);
    const base = (r) => ['--prefix', prefix, '--release', r.digest, '--hud-home', hudHome, '--shim-dir', shimDir];
    const receipts = [];
    function activate(entry, previewVerb, applyVerb, flags) {
      const p = command(entry, [previewVerb, ...flags]);
      const r = command(entry, [applyVerb, ...flags, '--plan', p.planId]);
      receipts.push(r.receipt);
      return { p, r };
    }
    function restore(entry, receipt) {
      const p = command(entry, ['restore-preview', '--receipt', receipt]);
      assert.deepEqual(p.conflicts, []);
      return command(entry, ['restore', '--receipt', receipt, '--plan', p.planId]);
    }
    const retained = {
      'config.json': '{"jev":{}}\n',
      'credentials.env': '# synthetic, no credentials\n',
      'routing.toml': 'schema = 1\n',
    };
    for (const [name, text] of Object.entries(retained)) put(path.join(hudHome, name), text);
    const artifactActivation = await load(path.join(ar, 'runtime-package/activation.mjs'));
    // An interrupted real A1 transaction exposes its receipt before returning failure.
    let interrupted;
    const partialOptions = {
      prefix,
      release: a.digest,
      hudHome,
      shimDir,
      path: env.PATH,
      steps: [{ kind: 'owned-file', path: path.join(hudHome, 'partial-example'), content: 'synthetic', mode: 0o600 }],
    };
    const partialPlan = artifactActivation.planActivation(partialOptions);
    assert.throws(
      () =>
        artifactActivation.applyActivation(partialOptions, partialPlan.planId, {
          checkpoint(phase, n, file) {
            if (phase === 'mutated' && partialPlan.actions[n].path.endsWith('/partial-example')) {
              interrupted = file;
              throw Error('partial_failure');
            }
          },
        }),
      /partial_failure/
    );
    restore(path.join(ar, 'pi-package.mjs'), interrupted);
    assert.equal(fs.existsSync(path.join(hudHome, 'partial-example')), false);
    report.steps.push({ name: 'partial failure has usable receipt restore route', status: 'PASS' });
    const rc = path.join(home, '.profile');
    const rcOriginal = '# >>> codex-hud >>>\n# legacy stays\n# <<< codex-hud <<<\n';
    put(rc, rcOriginal);
    const rcPlan = command(bootstrap, ['install', 'preview', ...base(a), '--rc-file', rc]);
    const rcApplied = command(bootstrap, ['install', 'apply', ...base(a), '--rc-file', rc, '--plan', rcPlan.planId]);
    restore(path.join(ar, 'pi-package.mjs'), rcApplied.receipt);
    assert.equal(fs.readFileSync(rc, 'utf8'), rcOriginal);
    report.steps.push({
      name: 'Row 3 optional PATH block preview/apply/restore preserves legacy markers',
      status: 'PASS',
    });
    // Keep the independent recovery/rc exercises before the main base receipt:
    // A1 proves one reverse hop, not an arbitrary chain of previously restored shims.
    const initialPlan = command(bootstrap, ['install', 'preview', ...base(a)]);
    const initial = command(bootstrap, ['install', 'apply', ...base(a), '--plan', initialPlan.planId]);
    const installedHud = path.join(ar, 'bin/hud');
    run(node, [installedHud, '--help']);
    const codexHome = env.CODEX_HOME,
      skillDirectory = path.join(home, '.agents/skills');
    const codexOriginal =
      '# Synthetic existing config: preserve bytes and mode.\n[mcp_servers.other]\ncommand = "other"\n[profiles.test]\nmodel = "synthetic"\n';
    put(path.join(codexHome, 'config.toml'), codexOriginal);
    fs.chmodSync(path.join(codexHome, 'config.toml'), 0o640);
    fs.mkdirSync(skillDirectory, { recursive: true, mode: 0o700 });
    put(path.join(skillDirectory, 'existing.txt'), 'pre-existing skill');
    const piSettings = path.join(home, '.pi/agent/settings.json');
    const piOriginal = '{ "packages": [], "theme": "synthetic" }\n';
    put(piSettings, piOriginal);
    fs.chmodSync(piSettings, 0o640);
    const claudeSettings = path.join(home, '.claude/settings.json');
    const claudeOriginal = '{ "env": {}, "statusLine": { "type": "command", "command": "old-statusline" } }\n';
    put(claudeSettings, claudeOriginal);
    fs.chmodSync(claudeSettings, 0o640);
    const compact = path.join(hudHome, 'synthetic-enabled-fields.json');
    put(compact, { model: true, context: true, cost: true });
    const inventory = path.join(hudHome, 'parity-inventory.json');
    const samples = { worker: [], mcp: [], statusline: [], panel: [], hook: [] };
    const fakeDir = path.join(out, 'fixtures');
    fs.mkdirSync(fakeDir, { mode: 0o700 });
    for (const file of ['pi-owned-herdr.mjs', 'pi-owned-worker.mjs', 'pi-owned-loader-worker.mjs', 'pi-package.mjs'])
      fs.copyFileSync(path.join(repo, 'tests/fakes', file), path.join(fakeDir, file));
    const piPackage = await (await load(path.join(fakeDir, 'pi-package.mjs'))).piPackage();
    assert.ok(piPackage, 'installed pi loader required for artifact rehearsal');
    report.piLoader = piPackage;
    async function enable(r) {
      const release = path.join(prefix, 'releases', r.digest),
        cp = path.join(release, 'claude-plugin.mjs'),
        pp = path.join(release, 'pi-package.mjs'),
        cx = path.join(release, 'codex-activation.mjs');
      // Native write-set changes happen in the existing isolated A4 probe, never guessed by A1.
      const parity = JSON.parse(
        run(node, [path.join(release, 'claude-parity.mjs'), 'preview', '--home', home, '--config', compact]).text
      );
      put(inventory, parity);
      const c = activate(cp, 'preview', 'apply', [...base(r), '--node', node, '--parity-inventory', inventory]);
      const p = activate(pp, 'preview', 'apply', [...base(r), '--node', node]);
      const row7 = activate(pp, 'row-7-preview', 'row-7-apply', [
        ...base(r),
        '--settings',
        piSettings,
        '--package',
        p.p.piPackage,
      ]);
      let row9;
      if (clients.codex) {
        const proof = command(cx, ['probe', '--codex', clients.codex, '--user-home', home, '--codex-home', codexHome]);
        const proofFile = path.join(out, `codex-proof-${r.digest}.json`);
        put(proofFile, proof);
        row9 = activate(cx, 'preview', 'apply', [
          ...base(r),
          '--node',
          node,
          '--codex',
          clients.codex,
          '--codex-home',
          codexHome,
          '--skill-directory',
          skillDirectory,
          '--proof',
          proofFile,
        ]);
        run(clients.codex, ['mcp', 'list']);
        const { codexRpc } = await load(cx);
        const listed = await codexRpc(
          clients.codex,
          ['app-server', '--stdio'],
          [
            {
              id: 1,
              method: 'initialize',
              params: {
                clientInfo: { name: 'hud_release_probe', version: '1' },
                capabilities: { experimentalApi: true },
              },
            },
            { method: 'initialized' },
            { id: 2, method: 'skills/list', params: { cwds: [home], forceReload: true } },
          ],
          env,
          home
        );
        assert.ok(
          listed.replies[2].result.data
            .flatMap((d) => d.skills)
            .some((s) => s.name === 'hud-delegate' && s.path === path.join(skillDirectory, 'hud-delegate/SKILL.md'))
        );
        report.smoke.push({
          item: 'Codex TOML and native skill discovery',
          status: 'PASS',
          release: r.digest,
          version: proof.version,
          command: proof.command,
          roleAdmission: 'NOT_RUN: identity_unverified remains intentional',
        });
      } else
        report.smoke.push({
          item: 'Codex TOML and skill discovery',
          status: 'NOT_RUN',
          reason: '--codex ABS required',
        });
      // Exercise row 6 through the actual plugin setup hook, including field-parity gate and existing writer.
      const hook = path.join(c.p.plugin, 'scripts/hook.mjs');
      const setup = (args) =>
        JSON.parse(
          JSON.parse(
            run(
              node,
              [hook],
              JSON.stringify({
                hook_event_name: 'UserPromptExpansion',
                expansion_type: 'slash_command',
                command_name: 'hud:setup',
                command_args: args,
              })
            ).text
          ).reason.slice(5)
        );
      const preview = setup('preview');
      assert.equal(preview.comparison.status, 'PASS');
      const planFile = path.join(out, `statusline-plan-${r.digest}-${receipts.length}.json`);
      put(planFile, preview.statusline);
      const switched = setup(`apply --plan '${planFile}'`);
      assert.equal(switched.status, 'DONE');
      const pref = activate(pp, 'row-10-preview', 'row-10-apply', [...base(r), '--panel-auto-open', 'false']);
      return { release, c, p, row7, row9, switched, pref, setup };
    }
    async function disable(v) {
      // Restore statusLine FIRST; exact JSON hash cannot survive a later native plugin settings mutation.
      assert.equal(v.setup(`restore --backup '${v.switched.statusline.backup}'`).status, 'DONE');
      for (const item of [v.pref, v.row9, v.row7, v.p, v.c].filter(Boolean))
        restore(path.join(v.release, 'pi-package.mjs'), item.r.receipt);
      assert.equal(fs.readFileSync(codexHome + '/config.toml', 'utf8'), codexOriginal);
      assert.equal(fs.statSync(codexHome + '/config.toml').mode & 0o777, 0o640);
      assert.equal(fs.readFileSync(piSettings, 'utf8'), piOriginal);
      assert.equal(fs.statSync(piSettings).mode & 0o777, 0o640);
      assert.equal(fs.readFileSync(claudeSettings, 'utf8'), claudeOriginal);
      assert.equal(fs.statSync(claudeSettings).mode & 0o777, 0o640);
      assert.deepEqual(fs.readdirSync(skillDirectory), ['existing.txt']);
    }
    let current = await enable(a);
    // Real role MCP initialize + exact six-tool discovery; no authenticated role calls are claimed.
    const { codexRpc } = await load(path.join(ar, 'codex-activation.mjs'));
    for (let i = 0; i < 3; i++) {
      const mcp = await codexRpc(
        node,
        [path.join(ar, 'packages/hud-mcp/bin/hud-mcp.mjs')],
        [
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'synthetic-release', version: '1' },
            },
          },
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        ],
        { ...env, HUD_MCP_SURFACE: 'roles' },
        home,
        async (child) => {
          const before = proc(child.pid);
          await pause(1100);
          const after = proc(child.pid);
          (report.mcpProcesses ??= []).push({
            tree: [proc(process.pid), after],
            idleWindowMs: 1100,
            contextSwitches: after.voluntary + after.nonvoluntary - before.voluntary - before.nonvoluntary,
            cpuTicks: after.ticks - before.ticks,
          });
        }
      );
      assert.deepEqual(mcp.replies[2].result.tools.map((t) => t.name).sort(), [
        'hud_close',
        'hud_create',
        'hud_read',
        'hud_respond',
        'hud_roster',
        'hud_send',
      ]);
      samples.mcp.push(mcp.readyMs);
    }
    report.smoke.push({
      item: 'Artifact MCP initialize and tools/list',
      status: 'PASS',
      command: [node, path.join(ar, 'packages/hud-mcp/bin/hud-mcp.mjs')],
      release: a.digest,
    });
    if (clients.claude) {
      const probeFile = path.join(out, 'r6a-claude-probe.mjs');
      fs.copyFileSync(path.join(repo, 'tests/integration/r6a-claude-probe.mjs'), probeFile);
      const { probeClaude } = await load(probeFile);
      const smoke = await probeClaude(current.c.p.plugin, clients.claude);
      put(path.join(out, 'claude-smoke.json'), smoke);
      const writes = await probeClaude(current.c.p.plugin, clients.claude, 'writes', null, { manualBackup: true });
      put(path.join(out, 'claude-write-set.json'), writes);
      report.smoke.push({
        item: 'Claude validate/load /hud:hud zero remote provider requests',
        status: smoke.status === 'PASS' ? 'PASS' : 'FAIL',
        version: smoke.cli.stdout.trim(),
        commands: smoke.results.map((r) => ({ args: r.args, requests: r.requests })),
        evidence: 'claude-smoke.json',
        note: 'ordinary negative control uses local rejecting recorder only; zero external model calls',
      });
      report.smoke.push({
        item: 'Claude native manager install/uninstall write-set',
        status: writes.status === 'PASS' ? 'PASS' : 'FAIL',
        evidence: 'claude-write-set.json',
      });
      assert.equal(smoke.status, 'PASS');
      // Native-manager qualification is an owner gate separate from the transient artifact load.
      // Assess observed native writes, not vendor-version pins. Synthetic copy-back
      // also checks exact post-uninstall hashes; it never grants access to an owner home.
      if (writes.status !== 'PASS')
        (report.ownerGates ??= []).push({
          item: 'Claude live native-manager qualification',
          status: 'NOT_RUN',
          version: writes.cli.stdout.trim(),
          residueCheck: writes.residueCheck,
          reason: writes.manualBackup.reason,
        });
      assert.equal(writes.manualBackup.restored, true, JSON.stringify(writes.residueCheck));
      report.commands.push(...writes.manualBackup.commands);
      report.steps.push({
        name: 'Row 4 manual backup: no HUD transaction; native write-set probe plus cp -p/cmp rehearsal',
        status: writes.manualBackup.restored ? 'PASS' : 'NOT_RUN',
        reason: writes.manualBackup.reason ?? null,
      });
      if (smoke.aliasReady) {
        const proof = path.join(out, 'claude-smoke.json');
        const alias = activate(path.join(ar, 'claude-plugin.mjs'), 'preview', 'apply', [
          ...base(a),
          '--node',
          node,
          '--parity-inventory',
          inventory,
          '--alias-proof',
          proof,
          '--alias-home',
          home,
        ]);
        assert.equal(fs.existsSync(path.join(home, '.claude/commands/hud.md')), true);
        restore(path.join(ar, 'claude-plugin.mjs'), alias.r.receipt);
      }
      report.smoke.push({
        item: 'Claude bare alias qualification',
        status: smoke.aliasReady ? 'PASS' : 'NOT_RUN',
        note: 'external hook timeout remains NOT_VERIFIED; owner must separately confirm alias',
      });
    } else report.smoke.push({ item: 'Claude native smoke', status: 'NOT_RUN', reason: '--claude ABS required' });
    if (clients.pi) {
      const at = performance.now();
      const pi = spawn(clients.pi, ['--mode', 'rpc', '--no-approve', '--no-mcp'], {
        env,
        cwd: home,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '',
        stderr = '';
      pi.stdout.on('data', (b) => (stdout += b));
      pi.stderr.on('data', (b) => (stderr += b));
      const closed = once(pi, 'close');
      const timer = setTimeout(() => pi.kill('SIGKILL'), 15000);
      pi.stdin.write(JSON.stringify({ id: 'hud-local', type: 'prompt', message: '/hud status' }) + '\n');
      await until(() => stdout.includes('hud-local') || pi.exitCode !== null, 12000);
      pi.stdin.end();
      pi.kill('SIGTERM');
      await closed;
      clearTimeout(timer);
      put(path.join(out, 'pi-smoke.json'), { stdout, stderr, ms: performance.now() - at });
      assert.match(stdout, /"id":"hud-local"/);
      assert.doesNotMatch(stdout, /"type":"agent_start"/);
      assert.match(stdout, /"success":true/);
      report.smoke.push({
        item: 'Pi personal package discovery and /hud (RPC, no provider turn)',
        status: 'PASS',
        version: run(clients.pi, ['--version']).text.trim(),
        command: [clients.pi, '--mode', 'rpc', '--no-approve', '--no-mcp'],
        evidence: 'pi-smoke.json',
      });
    } else report.smoke.push({ item: 'Pi real CLI /hud', status: 'NOT_RUN', reason: '--pi ABS required' });
    // Cold statusline, hook refusal and panel spawn through alternate-screen entry.
    // The non-TTY probe does not establish a painted frame or interactive readiness.
    for (let i = 0; i < 3; i++) {
      samples.statusline.push(
        run(
          node,
          [path.join(ar, 'bin/hud-statusline')],
          JSON.stringify({
            model: { display_name: 'Synthetic' },
            context_window: { used_percentage: 25 },
            cost: { total_cost_usd: 0 },
          })
        ).ms
      );
      const hook = run(
        node,
        [path.join(current.c.p.plugin, 'scripts/hook.mjs')],
        JSON.stringify({
          hook_event_name: 'UserPromptExpansion',
          expansion_type: 'slash_command',
          command_name: 'hud:hud',
          command_args: 'status',
          session_id: 'synthetic',
        })
      );
      assert.equal(JSON.parse(hook.text).decision, 'block');
      samples.hook.push(hook.ms);
      const started = performance.now();
      const panel = spawn(node, [installedHud, 'panel'], { env, cwd: home, stdio: ['pipe', 'pipe', 'pipe'] });
      let frame = '',
        errors = '';
      panel.stdout.on('data', (b) => (frame += b));
      panel.stderr.on('data', (b) => (errors += b));
      const closed = once(panel, 'close');
      try {
        await until(() => frame.includes('\x1b[?1049h') || panel.exitCode !== null, 10000);
        assert.match(frame, /\x1b\[\?1049h/, errors);
        samples.panel.push(performance.now() - started);
        const before = proc(panel.pid);
        await pause(1100);
        const after = proc(panel.pid);
        (report.panelProcesses ??= []).push({
          tree: [proc(process.pid), after],
          idleWindowMs: 1100,
          contextSwitches:
            after && before ? after.voluntary + after.nonvoluntary - before.voluntary - before.nonvoluntary : null,
          cpuTicks: after && before ? after.ticks - before.ticks : null,
        });
      } finally {
        panel.stdin.end();
        const timer = setTimeout(() => panel.kill('SIGKILL'), 3000);
        await closed;
        clearTimeout(timer);
      }
    }
    // No duplicated pi SDK and no runtime imports of the owner's toolkit (scan only the owned execution closure).
    const manifest = read(path.join(ar, 'RUNTIME-MANIFEST.json'));
    assert.equal(
      manifest.entries.some((e) => e.path.startsWith('node_modules/@earendil-works/')),
      false
    );
    for (const e of manifest.entries.filter(
      (e) => e.path.startsWith('dist/roles/pi-owned/') || e.path === 'dist/harness/pi/role-extension.js'
    ))
      assert.doesNotMatch(
        fs.readFileSync(path.join(ar, e.path), 'utf8'),
        /(?:from\s*|import\s*\()["'][^"']*(?:Fishpref|pi-roles|\/home\/)/
      );
    report.steps.push({ name: 'no SDK duplication or private toolkit imports', status: 'PASS' });
    // E06 is driven by the real pinned orchestration in a LIVE old worker process, not a fabricated receipt.
    const old = await ownedFixture({
      root: path.join(out, 'old-primary'),
      release: ar,
      env,
      piPackage,
      fakeDir,
      mode: { startup: 'real-loader' },
    });
    cleanup.push(old.close);
    const oldLaunch = await old.launch();
    assert.equal(oldLaunch.state, 'acked', oldLaunch.reason);
    await disable(current);
    // Owner-approved boundary: reverse the base too, then select the next release
    // from an unselected state. Retained releases and live workers are not touched.
    restore(path.join(ar, 'pi-package.mjs'), initial.receipt);
    const upgrade = command(bootstrap, ['install', 'preview', ...base(b)]);
    const upgraded = command(bootstrap, ['install', 'apply', ...base(b), '--plan', upgrade.planId]);
    current = await enable(b);
    old.mode({ helper: 'nested-sonic', startup: 'good' });
    // Existing loader fixture invokes the actual installed extension tool in the
    // retained primary; helper model turns use the existing provider-free fixture.
    const sent = await old.run([
      'test',
      'probe',
      old.journal().name,
      JSON.stringify({ tool: 'call_reviewer', params: {} }),
    ]);
    assert.equal(sent.ok, true, sent.stderr);
    await until(() => fs.existsSync(path.join(old.directory, '.dispatch/primary/probe-result.json')), 20000);
    const helperProbe = read(path.join(old.directory, '.dispatch/primary/probe-result.json'));
    assert.equal(helperProbe.answer.isError, false, JSON.stringify(helperProbe));
    for (const slot of ['review-1', 'sonic-1']) {
      const c = read(path.join(old.directory, '.dispatch', slot, 'contract.json'));
      assert.equal(c.release.root, ar);
      assert.equal(c.release.id, a.digest);
    }
    report.steps.push({
      name: 'E06 activation change while live N primary launches N reviewer and nested sonic',
      status: 'PASS',
    });
    await old.close();
    cleanup.pop();
    for (const mode of ['missing', 'outdated', 'header-mismatch']) {
      const f = await ownedFixture({
        root: path.join(out, 'integration-' + mode),
        release: ar,
        env,
        piPackage,
        fakeDir,
        mode: mode === 'header-mismatch' ? {} : { integration: mode },
      });
      cleanup.push(f.close);
      if (mode === 'header-mismatch')
        put(f.integration, '// HERDR_INTEGRATION_ID=foreign\n// HERDR_INTEGRATION_VERSION=9\n');
      const refused = await f.launch();
      assert.equal(refused.state, 'launch_unknown');
      assert.match(refused.reason, /herdr_pi_integration_missing/);
      assert.equal(f.state().counts.tab ?? 0, 0);
      await f.close();
      cleanup.pop();
    }
    for (let i = 0; i < 3; i++) {
      const f = await ownedFixture({
        root: path.join(out, 'loader-' + i),
        release: ar,
        env,
        piPackage,
        fakeDir,
        mode: { startup: 'real-loader' },
      });
      cleanup.push(f.close);
      const at = performance.now();
      const launched = await f.launch();
      assert.equal(launched.state, 'acked', launched.reason);
      samples.worker.push(performance.now() - at);
      const evidence = read(path.join(f.directory, '.dispatch/primary/loader-evidence.json'));
      assert.deepEqual(evidence.errors, []);
      assert.equal(evidence.extensions, 2);
      assert.equal(evidence.ownerWriters, 1);
      assert.equal(evidence.tools.filter((t) => t === 'call_reviewer').length, 1);
      assert.ok(!evidence.tools.some((t) => t === 'hud_create'));
      // The herdr-managed test reporter is loaded as a separate second entry; no second HUD worker owner.
      assert.equal(fs.readFileSync(path.join(f.root, 'reporter-events'), 'utf8'), 'session_start\n');
      const owner = read(path.join(f.directory, '.dispatch/primary/owner.json'));
      const before = proc(owner.process.pid);
      await pause(1100);
      const after = proc(owner.process.pid);
      (report.workerProcesses ??= []).push({
        tree: [proc(f.server.pid), after],
        idleWindowMs: 1100,
        contextSwitches: after.voluntary + after.nonvoluntary - before.voluntary - before.nonvoluntary,
        cpuTicks: after.ticks - before.ticks,
      });
      const writes = fs.readFileSync(path.join(f.directory, '.dispatch/primary/status-writes.json'), 'utf8');
      await pause(200);
      assert.equal(fs.readFileSync(path.join(f.directory, '.dispatch/primary/status-writes.json'), 'utf8'), writes);
      const unchanged = fs.readFileSync(f.integration, 'utf8');
      put(f.integration + '.replacement', unchanged);
      fs.renameSync(f.integration + '.replacement', f.integration);
      const replaced = await f.launch();
      assert.equal(replaced.state, 'launch_unknown');
      assert.match(replaced.reason, /herdr_pi_integration_missing/);
      assert.equal(f.state().counts.start, 1);
      await f.close();
      cleanup.pop();
    }
    report.smoke.push({
      item: 'Owned worker real installed pi loader; two entries, one owner + one reporter',
      status: 'PASS',
      version: piPackage.version,
      release: a.digest,
      scope: 'synthetic herdr transport, real loader, no provider',
    });
    await disable(current);
    restore(path.join(ar, 'pi-package.mjs'), upgraded.receipt);
    const rollbackPlan = command(bootstrap, ['install', 'preview', ...base(a)]);
    const rolledBack = command(bootstrap, ['install', 'apply', ...base(a), '--plan', rollbackPlan.planId]);
    current = await enable(a);
    await disable(current);
    const uninstall = command(bootstrap, ['uninstall', 'preview', '--receipt', rolledBack.receipt]);
    assert.deepEqual(uninstall.conflicts, []);
    const removed = command(bootstrap, [
      'uninstall',
      'apply',
      '--receipt',
      rolledBack.receipt,
      '--plan',
      uninstall.planId,
    ]);
    assert.equal(removed.status, 'deactivated; release retained');
    assert.equal(fs.existsSync(path.join(prefix, 'current')), false);
    assert.equal(fs.existsSync(shimDir), false);
    assert.equal(fs.existsSync(ar), true);
    assert.equal(fs.existsSync(br), true);
    for (const [name, text] of Object.entries(retained))
      assert.equal(fs.readFileSync(path.join(hudHome, name), 'utf8'), text);
    report.steps.push({
      name: 'E04 fresh install -> clients -> upgrade -> rollback -> uninstall; configs exact bytes/modes, no duplicate MCP',
      status: 'PASS',
    });
    for (const [key, v] of Object.entries(samples))
      report.cost[key] = { milliseconds: stats(v), samples: v, warmup: 0, runs: 3 };
    report.cost.scope =
      'Three independent cold invocations per operation, nearest rank. Worker uses real installed pi loader with synthetic herdr; no model duration. Panel alternate-screen entry (non-TTY), not a painted frame or interactive readiness. RSS and context switches are /proc observations, not hardware wakeup interrupts or WSL qualification.';
    report.smoke.push({
      item: 'Real herdr, provider turns, owner homes, browser and live attribution',
      status: 'NOT_RUN',
      reason: 'R7 owner gates; no authorization to use real resources',
    });
    report.status = 'PASS'; // Artifact scenarios do not waive separate native/owner gates.
    report.acceptance = report.ownerGates?.length ? 'OWNER_GATES_REMAIN' : 'ARTIFACT_SCENARIOS_PASS';
  } catch (e) {
    report.status = 'FAIL';
    report.error = e.stack;
    throw e;
  } finally {
    for (const fn of cleanup.reverse()) await fn();
    if (fs.existsSync(clone)) fs.rmSync(clone, { recursive: true, force: true });
    put(path.join(out, 'rehearsal.json'), report);
  }
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--run')
    console.log('SKIP: opt in with --run --out NEW_ABS_DIRECTORY [--codex ABS --claude ABS --pi ABS]');
  else {
    const o = {};
    for (let i = 3; i < process.argv.length; i += 2) o[process.argv[i]] = process.argv[i + 1];
    await rehearse(o['--out'], { codex: o['--codex'], claude: o['--claude'], pi: o['--pi'] });
  }
}
