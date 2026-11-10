// Synthetic installed pi process. Real package implementation, bridge, fd3 and facade.
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import cp from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
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
