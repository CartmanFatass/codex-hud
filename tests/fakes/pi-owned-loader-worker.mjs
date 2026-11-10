/** Provider-free host probe: real installed loader and SessionManager, fake event/context. */
import * as fs from 'node:fs';
import fsDefault from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
const option = (flag) => process.argv[process.argv.indexOf(flag) + 1];
const file = option('--hud-role-contract');
const c = JSON.parse(fs.readFileSync(file, 'utf8'));
// Count actual atomic STATUS replacements made by the real extension in this process.
const nativeRename = fsDefault.renameSync;
let statusWrites = 0;
fsDefault.renameSync = (from, to) => {
  nativeRename(from, to);
  if (String(to) === (c.slot === 'primary' ? join(c.task_dir, 'STATUS.json') : join(dirname(file), 'STATUS.json'))) {
    statusWrites++;
    fs.writeFileSync(join(dirname(file), 'status-writes.json'), JSON.stringify({ statusWrites }), { mode: 0o600 });
  }
};
syncBuiltinESMExports();
const root = process.env.OWNED_PI_PACKAGE;
const { loadExtensions, createExtensionRuntime } = await import(
  pathToFileURL(join(root, 'dist/core/extensions/loader.js')).href
);
const { SessionManager } = await import(pathToFileURL(join(root, 'dist/core/session-manager.js')).href);
const manager = SessionManager.create(c.cwd, c.session_dir, { id: c.session_id });
fs.chmodSync(c.session_dir, 0o700);
let active = [];
const runtime = createExtensionRuntime();
runtime.getSettings = () => ({ cacheWarming: 'off' });
runtime.setActiveTools = (names) => {
  active = names;
};
runtime.flagValues.set('hud-role-contract', file);
runtime.flagValues.set('hud-role-file', option('--hud-role-file'));
const paths = [join(c.release.root, 'integrations/pi/worker.ts'), c.herdr_integration.path];
const loaded = await loadExtensions(paths, c.cwd, undefined, runtime);
let shutdown = false;
let aborted = false;
const ctx = {
  cwd: c.cwd,
  model: {
    provider: c.model.split('/')[0],
    id: c.model.slice(c.model.indexOf('/') + 1),
    ...(process.env.OWNED_FAKE_TTL ? { promptCache: { short: Number(process.env.OWNED_FAKE_TTL) } } : {}),
  },
  thinkingLevel: c.effort,
  sessionManager: manager,
  isIdle: () => true,
  hasPendingMessages: () => false,
  abort: () => {
    aborted = true;
  },
  shutdown: () => {
    shutdown = true;
  },
};
if (process.env.OWNED_STARTUP_MODE === 'real-model-mismatch') ctx.model.id = 'wrong';
if (process.env.OWNED_STARTUP_MODE === 'real-effort-mismatch') ctx.thinkingLevel = 'off';
const emit = async (type, event = {}) => {
  let last;
  for (const ext of loaded.extensions)
    for (const h of ext.handlers.get(type) ?? []) last = await h({ type, ...event }, ctx);
  return last;
};
await emit('session_start', { reason: 'startup' });
const snapshot = {
  errors: loaded.errors,
  extensions: loaded.extensions.length,
  tools: loaded.extensions.flatMap((e) => [...e.tools.keys()]),
  active,
  shutdown,
  aborted,
  ownerWriters: loaded.extensions.filter((e) => e.flags.has('hud-role-contract')).length,
  sessionPersisted: fs.existsSync(manager.getSessionFile()),
};
fs.writeFileSync(join(dirname(file), 'loader-evidence.json'), JSON.stringify(snapshot), { mode: 0o600 });
const keepAlive = setInterval(() => {}, 60000);
process.on('message', async (msg) => {
  if (msg.type === 'quit') {
    await emit('session_shutdown', { reason: 'quit' });
    clearInterval(keepAlive);
    process.exit(0);
  }
  if (msg.type === 'prompt') {
    manager.appendMessage({ role: 'user', content: [{ type: 'text', text: msg.text }], timestamp: Date.now() });
    process.send?.({ type: 'submitted' });
  }
  if (msg.type === 'probe') {
    let answer;
    try {
      if (msg.builtinWrite) {
        const { createWriteTool } = await import(pathToFileURL(join(root, 'dist/core/tools/write.js')).href);
        answer = await createWriteTool(c.cwd).execute(
          'write-probe',
          { path: c.output_path, content: 'native tool report\n' },
          undefined
        );
      } else if (msg.tool) {
        const tool = loaded.extensions
          .flatMap((e) => [...e.tools.values()])
          .find((t) => t.definition.name === msg.tool);
        answer = tool
          ? await tool.definition.execute('probe', msg.params ?? {}, undefined, undefined, ctx)
          : { missing: true };
      } else answer = await emit(msg.event, msg.payload);
    } catch (e) {
      answer = { error: e.message };
    }
    fs.writeFileSync(join(dirname(file), 'probe-result.json'), JSON.stringify({ answer, shutdown, aborted }), {
      mode: 0o600,
    });
  }
});
process.send?.({ type: 'ready', session: manager.getSessionFile() });
