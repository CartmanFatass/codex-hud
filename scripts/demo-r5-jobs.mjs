#!/usr/bin/env node
/**
 * Maintainer-only R5 synthetic Windows Terminal acceptance stage (not a product command).
 * Build first: npm run build. No provider, browser, real Herdr, or user-home access.
 *   node scripts/demo-r5-jobs.mjs stage|open|frames|stop --dir /absolute/new-stage
 * open requires WSL_DISTRO_NAME and wt.exe; never reuses an existing WT window.
 * Owner ruling: opening our new windows may focus them. We never manipulate other windows.
 * stop checks Linux /proc start ticks, panel before wrapper; WT closeOnExit may leave an empty window.
 * Record-only formats below mirror tests/fixtures/r5-jobs.ts: receipt/STATUS/Jev writers are private.
 */
import * as fs from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const SCRIPT = fileURLToPath(import.meta.url);
export const ROOT = 'synthetic/r5-acceptance';
export const WINDOWS = [
  { title: 'R5ACC-EN', width: 110, height: 40, language: 'en' },
  { title: 'R5ACC-ZH', width: 110, height: 40, language: 'zh' },
  { title: 'R5ACC-NARROW', width: 44, height: 40, language: 'en' },
];
const id = (n) => `j${n.toString(16).padStart(16, '0')}`;
const stamp = (now, seconds) => new Date(now - seconds * 1000).toISOString();
const json = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new Error(`unreadable or invalid JSON: ${file}`, { cause });
  }
};
async function writer() {
  return (await import('../dist/roles/job-store.js')).writePrivate;
}

/** Allowlist, not an inherited environment with a few home overrides. No credentials or tmux identity. */
export function stageEnv(dir, language = 'en') {
  dir = resolve(dir);
  const codex = join(dir, `codex-${language}`);
  return {
    HOME: join(dir, 'home'),
    HUD_HOME: join(dir, 'hud'),
    CODEX_HOME: codex,
    CLAUDE_CONFIG_DIR: join(dir, 'home', '.claude'),
    PI_CODING_AGENT_DIR: join(dir, 'home', '.pi', 'agent'),
    XDG_CONFIG_HOME: join(dir, 'home', '.config'),
    XDG_CACHE_HOME: join(dir, 'home', '.cache'),
    XDG_DATA_HOME: join(dir, 'home', '.local', 'share'),
    TMPDIR: join(dir, 'tmp'),
    PATH: [join(dir, 'bin'), dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
    NO_COLOR: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: dir,
    CODEX_HUD_CWD: join(dir, 'project'),
    HUD_SETTINGS_PATH: join(codex, 'hud-settings.json'),
    CODEX_HUD_SETTINGS_PATH: join(codex, 'hud-settings.json'),
  };
}
function isolate(env) {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
}

export function requireStage(dir) {
  dir = resolve(dir);
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(dir) !== dir) throw new Error();
    const meta = json(join(dir, 'stage.json'));
    if (meta.schema !== 1 || meta.kind !== 'r5-acceptance' || meta.dir !== dir || meta.root !== ROOT) throw new Error();
    return meta;
  } catch {
    throw new Error(`not an R5 stage: ${dir} (run stage with a new directory first)`);
  }
}

export async function stage(dir) {
  dir = resolve(dir);
  // Check the existing parent before any write through it, then create exclusively.
  if (fs.realpathSync(dirname(dir)) !== dirname(dir))
    throw new Error('stage path must be canonical (no symlink ancestors)');
  fs.mkdirSync(dir, { mode: 0o700 });
  const env = stageEnv(dir);
  isolate(env);
  const put = await writer();
  const putJson = (file, value) => put(file, JSON.stringify(value) + '\n');
  for (const path of [
    env.HOME,
    env.HUD_HOME,
    env.CODEX_HOME,
    join(dir, 'codex-zh'),
    env.TMPDIR,
    join(dir, 'project'),
    join(dir, 'bin'),
    env.CLAUDE_CONFIG_DIR,
    env.PI_CODING_AGENT_DIR,
    env.XDG_CONFIG_HOME,
    env.XDG_CACHE_HOME,
    env.XDG_DATA_HOME,
  ])
    fs.mkdirSync(path, { recursive: true, mode: 0o700 });
  // An unborn synthetic repository stops both Node project scanners (.git/HEAD)
  // and real Git discovery, even when the stage is nested inside a user's checkout.
  // Plain fixture files only: never run a Git mutation against any repository.
  const git = join(dir, 'project', '.git');
  for (const part of ['objects', 'refs/heads']) fs.mkdirSync(join(git, part), { recursive: true, mode: 0o700 });
  put(join(git, 'HEAD'), 'ref: refs/heads/r5-synthetic\n');
  put(join(git, 'config'), '[core]\nrepositoryformatversion = 0\nbare = false\nfilemode = false\n');
  put(join(dir, 'gitconfig'), '');
  const now = Date.now();
  const { writeAssociation } = await import('../dist/roles/association.js');
  const { defaultSettings } = await import('../dist/settings.js');
  for (const language of ['en', 'zh']) {
    const settings = {
      ...defaultSettings(),
      language,
      panelStyle: 'rich',
      finishedLingerMs: 0,
      cardSubagentScope: 'all',
      cardSummary: false,
      cardSubagentSummary: false,
      cardRoleCounts: false,
      cardRelations: false,
      cardAction: true,
      cardRate: false,
      cardContext: false,
      glyphs: 'text',
      motion: 'reduced',
      briefing: 'off',
      agentProgress: false,
      agentLabels: false,
      notify: false,
      notifyDesktop: false,
    };
    putJson(join(dir, `codex-${language}`, 'hud-settings.json'), settings);
  }
  const agents = [];
  function association(n, name, { role = 'imp', jev = false, closed = false, live = true, harness = 'codex' } = {}) {
    const job = id(n);
    const location = jev
      ? { agent: null, tab_id: null, pane_id: null, workspace_id: null }
      : { agent: `r5-agent-${n}`, tab_id: `r5-tab-${n}`, pane_id: `r5-pane-${n}`, workspace_id: null };
    if (!jev && live)
      agents.push({
        name: location.agent,
        tab_id: location.tab_id,
        pane_id: location.pane_id,
        agent_status: 'working',
      });
    const a = {
      schema: 1,
      job,
      root: ROOT,
      role,
      phase: role === 'oracle' ? 'propose' : null,
      preset: 'synthetic',
      task_label: name,
      cwd: join(dir, 'project'),
      backend: {
        id: jev ? 'synthetic-jev' : 'synthetic-cli',
        executor: jev ? 'jev' : 'herdr',
        harness: jev ? null : harness,
        model: jev ? null : 'synthetic-model',
        effort: jev ? null : 'high',
        env_profile: null,
        recipe: jev ? null : harness === 'pi' ? 'pi-role' : 'codex-exec',
      },
      herdr: location,
      report_path: join(env.HUD_HOME, 'jobs', job, 'report.md'),
      closed,
      created_at: stamp(now, 180),
      ...(closed ? { closed_at: stamp(now, 30) } : {}),
    };
    writeAssociation(env.HUD_HOME, a);
    return a;
  }
  function receipt(a, state = 'open', dispatch = false) {
    const r = {
      schema: 1,
      job: a.job,
      parent: ROOT,
      request_key: `synthetic-${a.job}`,
      fingerprint: 'synthetic-fingerprint',
      role: a.role,
      phase: a.phase,
      routing_revision: 'synthetic',
      preset: a.preset,
      jev_decisions: { id: 'synthetic', provider: 'typesafe', model: 'synthetic-decision' },
      binding: { ...a.backend, target: null, mode: null, args: {}, wrapper: null, capabilities: [] },
      cwd: a.cwd,
      task_label: a.task_label,
      label: a.task_label,
      state,
      launch_error: null,
      prompted: true,
      steps: { tab_create: 'acked', launch: 'acked', rename: 'unsent', prompt: 'acked', tab_closed: a.closed },
      executor:
        a.backend.executor === 'herdr' ? { kind: 'herdr', ...a.herdr } : { kind: 'jev', job: `runtime-${a.job}` },
      closed_observation: null,
      ...(dispatch
        ? {
            pi_dispatch: {
              contract_version: 1,
              role: 'implementer',
              executable: join(dir, 'bin', 'pi-dispatch'),
              reaper: join(dir, 'bin', 'pi-role-reap'),
              launch: 'acked',
            },
          }
        : {}),
    };
    putJson(join(env.HUD_HOME, 'jobs', a.job, 'receipt.json'), r);
    fs.mkdirSync(join(env.HUD_HOME, 'jobs', a.job, 'qa'), { recursive: true, mode: 0o700 });
    return r;
  }
  function status(a, state, slot = 'primary') {
    const task = join(env.HUD_HOME, 'jobs', a.job);
    const closed = state === 'closed';
    putJson(slot === 'primary' ? join(task, 'STATUS.json') : join(task, '.dispatch', slot, 'STATUS.json'), {
      version: 1,
      task_dir: task,
      slot,
      role: slot === 'primary' ? 'implementer' : slot.startsWith('review-') ? 'reviewer' : 'sonic',
      model: 'synthetic-model',
      thinking: 'high',
      session_id: `synthetic-${a.job}-${slot}`,
      output_path: join(task, slot === 'primary' ? 'report.md' : `${slot}.md`),
      output_written: closed,
      state,
      helper_pending: null,
      started_at: stamp(now, 180),
      settled_at: closed ? stamp(now, 30) : null,
      idle_deadline_at: null,
      ended_at: closed ? stamp(now, 30) : null,
      exit_reason: closed ? 'completed' : null,
      error: null,
      updated_at: stamp(now, 2),
    });
  }
  receipt(association(1, 'Parser fix'));
  const docs = association(2, 'Docs sweep', { harness: 'pi' });
  receipt(docs, 'open', true);
  status(docs, 'working');
  status(docs, 'closed', 'sonic-1');
  status(docs, 'working', 'review-1');
  for (const [n, name, role, tag, result] of [
    [3, 'Design review', 'oracle', 'ask', { status: 'answered', answer: 'Synthetic design reviewed.' }],
    [
      4,
      'Page check',
      'jev',
      'judge',
      {
        statements: [
          { name: 'layout', verdict: 'pass' },
          { name: 'copy', verdict: 'deny' },
        ],
        calls: 1,
        extendedMs: 0,
      },
    ],
  ]) {
    const a = association(n, name, { role, jev: true, closed: true });
    const r = receipt(a, 'closed');
    // StoredJob from src/jev/runtime/executor.ts. No executor/runtime is instantiated.
    putJson(join(env.HUD_HOME, 'jev-runtime', 'jobs', `${r.executor.job}.json`), {
      executor: 'jev',
      id: r.executor.job,
      requestKey: r.request_key,
      fingerprint: r.fingerprint,
      session: { namespace: 'synthetic', sessionId: 'r5-acceptance' },
      tag,
      input:
        tag === 'ask'
          ? { tag, target: 'chatgpt-pro', label: name, prompt: 'Synthetic only' }
          : {
              tag,
              statements: [
                { name: 'layout', statement: 'Synthetic layout' },
                { name: 'copy', statement: 'Synthetic copy' },
              ],
            },
      decisionProfile: 'synthetic',
      provider: { id: 'typesafe', model: 'synthetic-decision' },
      state: 'completed',
      closed: true,
      seq: 1,
      result,
      createdAt: stamp(now, 180),
      phase: 'collect',
      run: { startedAt: stamp(now, 180), endedAt: stamp(now, 30) },
    });
  }
  // No runtime.json needed: settled Jev results do not require a live runtime.
  receipt(association(6, 'Old migration', { live: false }));
  const question = association(7, 'Schema question', { harness: 'pi' });
  receipt(question, 'open', true);
  status(question, 'waiting_orchestrator');
  put(join(env.HUD_HOME, 'jobs', question.job, 'qa', 'q1.md'), 'Synthetic question: which schema version?\n');
  receipt(association(8, 'Flaky test', { closed: true, live: false }), 'error');
  agents.push({ name: 'r5-external', pane_id: 'r5-pane-external', tab_id: 'r5-tab-external', agent_status: 'working' });
  putJson(join(dir, 'herdr-agents.json'), { result: { agents } });
  // Dedicated read-only shim: unsupported calls fail closed, never fall through to real Herdr.
  put(
    join(dir, 'bin', 'herdr'),
    `#!${process.execPath}\nimport fs from 'node:fs';\nif (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['agent','list','--json'])) process.exit(2);\nprocess.stdout.write(fs.readFileSync(new URL('../herdr-agents.json', import.meta.url), 'utf8'));\n`
  );
  putJson(join(dir, 'package.json'), { type: 'module' });
  fs.chmodSync(join(dir, 'bin', 'herdr'), 0o700);
  const { observeHerdrCommand } = await import('../dist/cli/observe-herdr.js');
  await observeHerdrCommand(
    [
      '--root',
      ROOT,
      '--id',
      'external-build',
      '--agent',
      'r5-external',
      '--pane',
      'r5-pane-external',
      '--tab',
      'r5-tab-external',
      '--label',
      'External build',
    ],
    {
      env,
      stdout() {},
      stderr(text) {
        throw new Error(text);
      },
    }
  );
  putJson(join(dir, 'pids.json'), []);
  // Completion marker last; open/frames refuse incomplete stages.
  putJson(join(dir, 'stage.json'), {
    schema: 1,
    kind: 'r5-acceptance',
    dir,
    root: ROOT,
    createdAt: new Date(now).toISOString(),
  });
  return dir;
}

/** Exact collector/composition class used by tree-page, including its real shim subprocess sampler. */
export async function collectStage(dir) {
  requireStage(dir);
  const { PanelJobPipeline } = await import('../dist/tree-page.js');
  const { runHerdrList } = await import('../dist/collectors/job-live-observation.js');
  const pipeline = new PanelJobPipeline(join(dir, 'hud'), ROOT, { herdr: runHerdrList(stageEnv(dir)) });
  try {
    await pipeline.refresh();
    await pipeline.live.settled();
    // Bounded reader slices need several ticks for STATUS/helpers/QA. No DTO injection.
    for (let n = 0; n < 20; n++) await pipeline.refresh();
    const nowMs = Date.now();
    return {
      ...pipeline.compose({ rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(nowMs) }, null, nowMs),
      nowMs,
    };
  } finally {
    pipeline.dispose();
  }
}
export async function frames(dir) {
  requireStage(dir);
  isolate(stageEnv(dir));
  const result = await collectStage(dir);
  const { initialMonitorState, monitorSettings, renderMonitor } = await import('../dist/render/monitor.js');
  const { withDisplaySettings } = await import('../dist/settings-runtime.js');
  const { setLanguage } = await import('../dist/render/i18n.js');
  const { stripAnsi } = await import('../dist/render/colors.js');
  const output = [];
  for (const language of ['en', 'zh'])
    for (const width of [110, 44]) {
      const settings = json(join(dir, `codex-${language}`, 'hud-settings.json'));
      const previous = setLanguage(language);
      try {
        let state = { ...initialMonitorState(), ...monitorSettings(settings) };
        state.tree = { ...state.tree, lingerMs: 0 };
        const frame = withDisplaySettings(settings, () =>
          renderMonitor({ tree: result.tree, state, nowMs: result.nowMs, width, height: 40, linkNames: true })
        );
        state = frame.state;
        output.push({ language, width, lines: frame.lines.map(stripAnsi) });
      } finally {
        setLanguage(previous);
      }
    }
  return output;
}

export function windowLaunch(dir, window, distro) {
  requireStage(dir);
  if (!distro || /[\r\n\0]/.test(distro)) throw new Error('open requires WSL_DISTRO_NAME');
  return {
    executable: 'wt.exe',
    argv: [
      '--window',
      'new',
      '--size',
      `${window.width},${window.height}`,
      '--title',
      window.title,
      '--suppressApplicationTitle',
      'wsl.exe',
      '--distribution',
      distro,
      '--exec',
      process.execPath,
      SCRIPT,
      'panel-run',
      '--dir',
      resolve(dir),
      '--title',
      window.title,
      '--language',
      window.language,
    ],
    env: stageEnv(dir, window.language),
  };
}
/** Linux kernel start ticks (not wall time, so PID reuse and clock adjustments are safe). */
export function processStart(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[0] === 'Z' ? null : fields[19];
  } catch {
    return null;
  }
}
async function record(dir, entries) {
  const lock = join(dir, 'pids.lock');
  for (let n = 0; ; n++) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST' || n >= 200) throw e;
      await sleep(10);
    }
  }
  try {
    const put = await writer();
    put(join(dir, 'pids.json'), JSON.stringify([...json(join(dir, 'pids.json')), ...entries]) + '\n');
  } finally {
    fs.rmdirSync(lock);
  }
}
async function panelRun(dir, title, language) {
  requireStage(dir);
  if (!WINDOWS.some((w) => w.title === title && w.language === language)) throw new Error('invalid stage window');
  isolate(stageEnv(dir, language));
  // Live windows show the panel in colour; reference frames stay plain.
  delete process.env.NO_COLOR;
  process.env.COLORTERM = 'truecolor';
  process.chdir(join(dir, 'project'));
  await record(dir, [{ pid: process.pid, startTime: processStart(process.pid), kind: 'wrapper', title }]);
  // This is the real `hud panel --root` command handler, not a substitute panel launcher.
  const { panelCommand } = await import('../dist/cli/panel.js');
  const running = panelCommand(
    { env: process.env, stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) },
    ['--root', ROOT]
  );
  // foreground() spawns synchronously; /proc lists only our own direct child here.
  const children = fs
    .readFileSync(`/proc/self/task/${process.pid}/children`, 'utf8')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
  await record(
    dir,
    children.map((pid) => ({ pid, startTime: processStart(pid), kind: 'panel', title }))
  );
  process.exitCode = await running;
}
async function open(dir) {
  requireStage(dir);
  const distro = process.env.WSL_DISTRO_NAME;
  for (const window of WINDOWS) {
    const launch = windowLaunch(dir, window, distro);
    if (json(join(dir, 'pids.json')).some((p) => p.title === window.title && processStart(p.pid) === p.startTime))
      throw new Error(`${window.title} already running`);
    // Retain WSL interop variables for wt.exe only; panel-run replaces its entire environment.
    await new Promise((done, fail) => {
      const child = spawn(launch.executable, launch.argv, { stdio: 'inherit', shell: false });
      child.once('error', fail);
      child.once('exit', (code) => (code === 0 ? done() : fail(new Error(`wt.exe exited ${code}`))));
    });
    let ready = false;
    for (let n = 0; n < 100; n++) {
      const rows = json(join(dir, 'pids.json')).filter(
        (p) => p.title === window.title && p.startTime && processStart(p.pid) === p.startTime
      );
      if (rows.some((p) => p.kind === 'wrapper') && rows.some((p) => p.kind === 'panel')) {
        ready = true;
        break;
      }
      await sleep(100);
    }
    console.log(
      `${window.title} ${window.width}x${window.height}: ${ready ? 'started' : 'NOT CONFIRMED (see pids.json; stop still cleans recorded processes)'}`
    );
    if (!ready) throw new Error('panel startup not confirmed');
  }
}
export async function stop(dir) {
  dir = resolve(dir);
  if (!fs.existsSync(dir)) return;
  requireStage(dir);
  const rows = json(join(dir, 'pids.json'));
  if (
    !Array.isArray(rows) ||
    rows.some(
      (p) => !Number.isSafeInteger(p.pid) || p.pid < 2 || typeof p.startTime !== 'string' || !/^\d+$/.test(p.startTime)
    )
  )
    throw new Error('invalid pids.json; refusing cleanup');
  const ordered = [...rows].sort((a, b) => Number(a.kind === 'wrapper') - Number(b.kind === 'wrapper'));
  for (const p of ordered) {
    if (processStart(p.pid) !== p.startTime) continue;
    try {
      process.kill(p.pid, 'SIGTERM');
    } catch (e) {
      if (e.code !== 'ESRCH') throw e;
    }
    for (let n = 0; n < 20 && processStart(p.pid) === p.startTime; n++) await sleep(50);
    if (processStart(p.pid) === p.startTime) {
      try {
        process.kill(p.pid, 'SIGKILL');
      } catch (e) {
        if (e.code !== 'ESRCH') throw e;
      }
      for (let n = 0; n < 20 && processStart(p.pid) === p.startTime; n++) await sleep(50);
      if (processStart(p.pid) === p.startTime) throw new Error(`recorded process ${p.pid} did not end; stage retained`);
    }
  }
  fs.rmSync(dir, { recursive: true });
  if (rows.length)
    console.log(
      'Recorded Linux processes ended. If WT closeOnExit leaves an empty window, close that R5ACC window manually.'
    );
}
async function main(args) {
  const [command, flag, rawDir, ...rest] = args;
  if (flag !== '--dir' || !rawDir || (!['panel-run'].includes(command) && rest.length))
    throw new Error('usage: demo-r5-jobs.mjs stage|open|frames|stop --dir <stage dir>');
  const dir = resolve(rawDir);
  if (command === 'stage') console.log(`Staged synthetic R5 jobs at ${await stage(dir)}`);
  else if (command === 'frames')
    for (const f of await frames(dir))
      console.log(`=== ${f.language.toUpperCase()} ${f.width}x40 ===\n${f.lines.join('\n')}`);
  else if (command === 'open') await open(dir);
  else if (command === 'stop') await stop(dir);
  else if (command === 'panel-run' && rest.length === 4 && rest[0] === '--title' && rest[2] === '--language')
    await panelRun(dir, rest[1], rest[3]);
  else throw new Error(`unknown command: ${command}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch((e) => {
    console.error(`R5 stage: ${e.message}`);
    process.exitCode = 1;
  });
