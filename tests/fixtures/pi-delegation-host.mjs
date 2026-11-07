// SYNTHETIC Pi callback host with a non-socket native-host port, not provider/IPC validation.
// Copied under a synthetic installed-package tuple by the test. All production
// bridge, process verification, stdio MCP, registry and ledger code is unchanged.
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@earendil-works/pi-coding-agent')
      return { url: 'data:text/javascript,export const VERSION="1.4.0";', shortCircuit: true };
    return next(specifier, context);
  },
});
const owned = new Set();
const originalSpawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  if (args[0] === process.execPath && args[1]?.some((arg) => arg.endsWith('/hud-mcp.mjs'))) {
    args[1] = ['--import', process.env.HUD_TEST_REPO + '/tests/fixtures/pi-native-host-port.mjs', ...args[1]];
  }
  const child = originalSpawn(...args);
  owned.add(child);
  child.once('close', () => owned.delete(child));
  return child;
};
syncBuiltinESMExports();
process.title = 'pi'; // Official 1.4.0 erases the OS cmdline; process.argv remains original.
const handlers = new Map(),
  tools = new Map(),
  commands = new Map();
const state = {
  sessionId: 'synthetic-a',
  sessionDir: process.argv[3],
  sessionFile: process.argv[3] + '/synthetic-a.jsonl',
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
const extension = await import(pathToFileURL(process.env.HUD_TEST_REPO + '/extensions/pi/hud-delegate.ts'));
extension.default(pi);
await handlers.get('session_start')({ reason: 'startup' }, ctx);
const children = () =>
  [...owned].filter((child) => child.exitCode === null && child.signalCode === null).map((child) => child.pid);
process.stdout.write(JSON.stringify({ ready: true, tools: [...tools.keys()] }) + '\n');
const lines = createInterface({ input: process.stdin });
// Do not serialize requests: lifecycle invalidation must be testable during a capture.
const running = new Set();
for await (const line of lines) {
  const request = JSON.parse(line);
  const task = (async () => {
    let result;
    try {
      if (request.kind === 'command') result = await commands.get('hud-delegate').handler(request.args ?? '', ctx);
      else if (request.kind === 'call')
        result = await tools.get(request.tool).execute(request.callId, request.args ?? {}, undefined, undefined, ctx);
      else if (request.kind === 'event') {
        await handlers.get(request.event)?.({ reason: request.reason }, ctx);
        result = true;
      } else if (request.kind === 'set') {
        Object.assign(state, request.state);
        result = true;
      } else if (request.kind === 'persist') {
        writeFileSync(state.sessionFile, JSON.stringify({ type: 'session', version: 3, id: state.sessionId }) + '\n');
        result = true;
      } else if (request.kind === 'kill') {
        const pids = children();
        for (const pid of pids) process.kill(pid, 'SIGKILL');
        result = pids;
      } else if (request.kind === 'children') result = children();
      else throw Error('unknown_fixture_action');
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
