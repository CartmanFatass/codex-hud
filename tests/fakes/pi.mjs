/** Provider-free pi profiles. Protocols remain distinct; package/loader discovery stays real. */
import * as fs from 'node:fs';
import { dirname, join, resolve, delimiter } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import cp from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

export async function runWorker() {
  const option = (flag) => process.argv[process.argv.indexOf(flag) + 1];
  const path = option('--hud-role-contract');
  const contract = JSON.parse(fs.readFileSync(path, 'utf8'));
  const journal = JSON.parse(fs.readFileSync(join(dirname(path), 'launch.json'), 'utf8'));
  const { readProcess } = await import(process.env.OWNED_PROCESS_MODULE);
  const put = (file, value) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value) + '\n';
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const session = join(contract.session_dir, `2000-01-01T00-00-00-000Z_${contract.session_id}.jsonl`);
  const header = { type: 'session', version: 3, id: contract.session_id, cwd: contract.cwd };
  put(join(dirname(path), 'owner.json'), {
    schema: 1,
    ready: true,
    session_header: { type: 'session', id: contract.session_id, cwd: contract.cwd },
    job: contract.job,
    slot: contract.slot,
    session_id: contract.session_id,
    session_file: session,
    instance: journal.instance,
    tab_id: journal.tab,
    pane_id: journal.pane,
    agent_name: journal.name,
    process: readProcess(process.pid).stamp,
    model: contract.model,
    effort: contract.effort,
  });
  const keepAlive = setInterval(() => {}, 60_000);
  process.on('message', async (message) => {
    if (message.type === 'quit') {
      clearInterval(keepAlive);
      process.exit(0);
    }
    if (message.type !== 'prompt') return;
    if (!fs.existsSync(session)) put(session, message.mode === 'header-mismatch' ? { ...header, id: 'wrong' } : header);
    fs.appendFileSync(
      session,
      JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: message.text }] } }) +
        '\n'
    );
    const orphan = message.mode?.startsWith('orphan-child');
    if (orphan && contract.role === 'sonic') {
      process.send?.({ type: 'submitted' });
      return;
    }
    if ((message.mode === 'nested-sonic' || orphan) && contract.role !== 'sonic') {
      for (let n = 0; n < 100; n++) {
        const j = JSON.parse(fs.readFileSync(join(dirname(path), 'launch.json'), 'utf8'));
        if (j.steps.prompt?.state === 'acked') break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const { callHelper } = await import(process.env.OWNED_HELPERS_MODULE);
      const { createHash } = await import('node:crypto');
      const resources = {};
      for (const relative of [
        'integrations/pi/worker.ts',
        'integrations/pi/skills/helper-pane/SKILL.md',
        ...['implementer', 'sonic', 'reviewer', 'architect'].map((r) => `integrations/pi/roles/${r}.md`),
      ])
        resources[relative] = createHash('sha256')
          .update(fs.readFileSync(join(contract.release.root, relative)))
          .digest('hex');
      const context = {
        jobDirectory: contract.task_dir,
        cwd: contract.cwd,
        release: { ...contract.release, resources },
      };
      const binding = JSON.parse(fs.readFileSync(join(contract.task_dir, '.dispatch/runtime.json'), 'utf8'));
      const request =
        contract.role === 'implementer'
          ? { kind: 'reviewer' }
          : { kind: 'sonic', brief_path: join(contract.task_dir, 'sonic-source.md') };
      const pending = callHelper(
        context,
        { ...binding, env: process.env, callerSlot: contract.slot, budgetMs: 10000, waitingHelper: async () => {} },
        request
      );
      if (orphan && contract.role === 'reviewer') {
        void pending.catch(() => {});
        const childJournal = join(contract.task_dir, '.dispatch/sonic-1/launch.json');
        for (let n = 0; n < 1000; n++) {
          if (
            fs.existsSync(childJournal) &&
            JSON.parse(fs.readFileSync(childJournal, 'utf8')).steps.prompt?.state === 'acked'
          )
            break;
          await new Promise((r) => setTimeout(r, 10));
        }
        if (message.mode === 'orphan-child-unknown')
          await new Promise((resolve) => {
            const ack = (m) => {
              if (m.type === 'orphan_fault_acked') {
                process.off('message', ack);
                resolve();
              }
            };
            process.on('message', ack);
            process.send?.({ type: 'orphan_fault' });
          });
        if (message.mode === 'orphan-child-crash') process.exit(0);
        // The child remains live; simulate a reviewer ending without its shutdown hook.
        message.mode = message.mode === 'orphan-child-failed' ? 'orphan-failed' : 'orphan-closed';
      } else {
        const answer = await pending;
        put(join(dirname(path), 'helper-outcome.json'), answer);
        if (!answer.ok) {
          process.send?.({ type: 'helper_failed', answer });
          return;
        }
      }
    }
    if (message.finish) {
      const output =
        message.mode === 'invalid-verdict'
          ? 'Not a verdict\n'
          : contract.role === 'reviewer'
            ? 'Verdict: accept\nSynthetic independent review.\n'
            : `Synthetic result for ${contract.slot}.\n`;
      if (!['missing-output', 'unchanged-output'].includes(message.mode)) put(contract.output_path, output);
      if (message.mode !== 'unsettled')
        put(contract.slot === 'primary' ? join(contract.task_dir, 'STATUS.json') : join(dirname(path), 'STATUS.json'), {
          version: 1,
          task_dir: contract.task_dir,
          slot: contract.slot,
          role: contract.role,
          session_id: contract.session_id,
          model: message.mode === 'wrong-model' ? 'wrong/model' : contract.model,
          thinking: message.mode === 'wrong-effort' ? 'off' : contract.effort,
          output_path: contract.output_path,
          output_written: message.mode !== 'missing-output',
          state: message.mode === 'orphan-failed' ? 'failed' : 'closed',
          helper_pending: null,
          settled_at: new Date().toISOString(),
          idle_deadline_at: null,
          ended_at: new Date().toISOString(),
          exit_reason: 'complete',
          error: null,
        });
      if (message.mode === 'stay-alive') process.send?.({ type: 'idle' });
      if (message.mode !== 'unsettled' && message.mode !== 'stay-alive') setTimeout(() => process.exit(0), 30);
    }
    process.send?.({ type: 'submitted' });
  });
  process.send?.({ type: 'ready', session });
}

/** Locate installed pi, including the managed PATH shim, without launching a CLI. */
export function piPackage() {
  const candidates = process.env.PI_PACKAGE_DIR ? [resolve(process.env.PI_PACKAGE_DIR)] : [];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    try {
      const exe = fs.realpathSync(join(dir, 'pi'));
      candidates.push(resolve(dirname(exe), '..'), resolve(dirname(exe), '../..'));
      const install = resolve(dirname(exe), '../install');
      const version = fs.readFileSync(join(install, 'current-version'), 'utf8').trim();
      if (/^[A-Za-z0-9._+-]+$/.test(version))
        candidates.push(join(install, 'releases', version, 'node_modules/@earendil-works/pi-coding-agent'));
    } catch {
      /* next PATH candidate */
    }
  }
  for (const root of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(join(root, 'package.json'), 'utf8'));
      if (pkg.name === '@earendil-works/pi-coding-agent' && fs.existsSync(join(root, 'dist/core/extensions/loader.js')))
        return { root, version: pkg.version };
    } catch {
      /* unavailable */
    }
  }
  return null;
}

export async function runPackageHost() {
  const { registerHooks } = await import('node:module');
  registerHooks({
    resolve(s, c, next) {
      if (/\/managed\/|\/managed-tools\.js$|\/host-ipc\.js$/.test(s)) throw Error('old_execution_host_loaded');
      return next(s, c);
    },
  });
  const children = new Set(),
    spawn = cp.spawn;
  cp.spawn = (...args) => {
    if (args[0] === process.execPath && args[1]?.some((a) => a.endsWith('/hud-mcp.mjs')))
      args[1] = ['--import', process.env.HUD_TEST_REPO + '/tests/fixtures/role-import-guard.mjs', ...args[1]];
    const c = spawn(...args);
    children.add(c);
    c.once('close', () => children.delete(c));
    return c;
  };
  syncBuiltinESMExports();
  process.title = 'pi';
  const loadAt = performance.now();
  const module = await import(
    pathToFileURL(
      process.env.HUD_TEST_PACKAGE
        ? process.env.HUD_TEST_PACKAGE + '/extensions/hud.mjs'
        : process.env.HUD_TEST_REPO + '/dist/harness/pi/package-entry.js'
    )
  );
  const handlers = new Map(),
    tools = new Map(),
    commands = new Map();
  const state = {
    sessionId: process.env.HUD_TEST_ID ?? 'synthetic-a',
    sessionDir: process.env.HUD_TEST_SESSIONS,
    sessionFile: process.env.HUD_TEST_UNASSIGNED ? undefined : process.env.HUD_TEST_SESSIONS + '/synthetic-a.jsonl',
  };
  const ctx = {
    cwd: process.cwd(),
    mode: 'rpc',
    hasUI: true,
    ui: {
      setStatus() {
        throw Error('rpc_status_forbidden');
      },
      setFooter() {
        throw Error('footer_forbidden');
      },
      notify() {},
    },
    sessionManager: {
      getSessionId: () => state.sessionId,
      getSessionFile: () => state.sessionFile,
      getSessionDir: () => state.sessionDir,
      getHeader: () => ({ type: 'session', id: state.sessionId, cwd: process.cwd() }),
    },
  };
  const pi = {
    on(event, fn) {
      const rows = handlers.get(event) ?? new Set();
      handlers.set(event, rows);
      rows.add(fn);
      return () => rows.delete(fn);
    },
    registerCommand: (n, c) => commands.set(n, c),
    registerTool: (t) => tools.set(t.name, t),
    sendUserMessage() {
      throw Error('model_path_forbidden');
    },
  };
  const binding = {
    version: 1,
    release: process.env.HUD_TEST_REPO,
    digest: 'a'.repeat(64),
    releaseVersion: '0.1.0',
    node: process.execPath,
    hudHome: process.env.HUD_HOME,
  };
  const emit = async (event) => {
    for (const fn of [...(handlers.get(event) ?? [])]) await fn({}, ctx);
  };
  const install = () => (process.env.HUD_TEST_PACKAGE ? module.default(pi) : module.installPiPackage(pi, binding));
  await install();
  const loadMs = performance.now() - loadAt;
  await emit('session_start');
  console.log(JSON.stringify({ ready: true, tools: [...tools.keys()], loadMs }));
  const running = new Set();
  for await (const line of createInterface({ input: process.stdin })) {
    const r = JSON.parse(line);
    const task = (async () => {
      try {
        let result;
        if (r.kind === 'call') {
          const started = performance.now();
          result = await tools.get(r.tool).execute(r.callId, r.args ?? {}, undefined, undefined, ctx);
          if (result.isError) throw Error(JSON.stringify(result.details));
          if (r.measure) {
            const pid = [...children][0]?.pid;
            result = {
              result,
              startupMs: performance.now() - started,
              rssKiB: pid ? Number(/VmRSS:\s+(\d+)/.exec(readFileSync('/proc/' + pid + '/status', 'utf8'))?.[1]) : null,
            };
          }
        } else if (r.kind === 'event') {
          if (r.event === 'session_start' && !handlers.get('session_start')?.size) await install();
          await emit(r.event);
          result = true;
        } else if (r.kind === 'set') {
          Object.assign(state, r.state);
          result = true;
        } else if (r.kind === 'persist') {
          state.sessionFile ??= state.sessionDir + '/' + state.sessionId + '.jsonl';
          writeFileSync(
            state.sessionFile,
            JSON.stringify({ type: 'session', version: 3, id: state.sessionId, cwd: process.cwd() }) + '\n'
          );
          result = true;
        } else if (r.kind === 'command') {
          await commands.get('hud').handler(r.args ?? '', ctx);
          result = true;
        } else if (r.kind === 'children') result = [...children].map((c) => c.pid);
        else if (r.kind === 'kill') {
          for (const c of children) c.kill('SIGKILL');
          result = true;
        } else throw Error('unknown_action');
        console.log(JSON.stringify({ id: r.id, result }));
      } catch (e) {
        console.log(JSON.stringify({ id: r.id, error: e.message }));
      }
    })();
    running.add(task);
    void task.finally(() => running.delete(task));
  }
  await emit('session_shutdown');
  await Promise.allSettled(running);
}
