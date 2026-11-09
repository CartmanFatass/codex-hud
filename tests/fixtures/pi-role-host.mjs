// Synthetic installed Pi callback host. Real extension, bridge, fd3, MCP and facade.
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
registerHooks({
  resolve(specifier, context, next) {
    if (/\/managed\/|\/managed-tools\.js$|\/host-ipc\.js$/.test(specifier)) throw Error('old_execution_host_loaded');
    return next(specifier, context);
  },
});
const owned = new Set();
const originalSpawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  if (args[0] === process.execPath && args[1]?.some((a) => a.endsWith('/hud-mcp.mjs')))
    args[1] = ['--import', process.env.HUD_TEST_REPO + '/tests/fixtures/role-import-guard.mjs', ...args[1]];
  const child = originalSpawn(...args);
  owned.add(child);
  child.once('close', () => owned.delete(child));
  return child;
};
syncBuiltinESMExports();
process.title = 'pi';
const handlers = new Map(),
  tools = new Map(),
  commands = new Map();
const state = {
  sessionId: 'synthetic-a',
  sessionDir: process.env.HUD_TEST_SESSIONS,
  sessionFile: process.env.HUD_TEST_UNASSIGNED ? undefined : process.env.HUD_TEST_SESSIONS + '/synthetic-a.jsonl',
};
const ctx = {
  cwd: process.cwd(),
  sessionManager: {
    getSessionId: () => state.sessionId,
    getSessionFile: () => state.sessionFile,
    getSessionDir: () => state.sessionDir,
  },
};
const pi = {
  on: (event, handler) => handlers.set(event, handler),
  registerTool: (tool) => tools.set(tool.name, tool),
  registerCommand: (name, command) => commands.set(name, command),
};
const extension = await import(pathToFileURL(process.env.HUD_TEST_REPO + '/extensions/pi/hud-roles.ts'));
extension.default(pi);
await handlers.get('session_start')({ reason: 'startup' }, ctx);
const children = () => [...owned].filter((c) => c.exitCode === null && c.signalCode === null).map((c) => c.pid);
process.stdout.write(JSON.stringify({ ready: true, tools: [...tools.keys()] }) + '\n');
const running = new Set();
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  const task = (async () => {
    try {
      let result;
      if (request.kind === 'call')
        result = await tools.get(request.tool).execute(request.callId, request.args ?? {}, undefined, undefined, ctx);
      else if (request.kind === 'command') result = await commands.get('hud-roles').handler(request.args ?? '', ctx);
      else if (request.kind === 'event') {
        await handlers.get(request.event)?.({ reason: request.reason }, ctx);
        result = true;
      } else if (request.kind === 'set') {
        Object.assign(state, request.state);
        result = true;
      } else if (request.kind === 'persist') {
        state.sessionFile ??= state.sessionDir + '/' + state.sessionId + '.jsonl';
        writeFileSync(state.sessionFile, JSON.stringify({ type: 'session', version: 3, id: state.sessionId }) + '\n');
        result = true;
      } else if (request.kind === 'children') result = children();
      else if (request.kind === 'kill') {
        result = children();
        for (const pid of result) process.kill(pid, 'SIGKILL');
      } else throw Error('unknown_fixture_action');
      process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ id: request.id, error: error.message }) + '\n');
    }
  })();
  running.add(task);
  void task.finally(() => running.delete(task));
}
await handlers.get('session_shutdown')({}, ctx);
await Promise.allSettled(running);
