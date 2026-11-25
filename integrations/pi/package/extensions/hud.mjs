/** HUD role tools in main sessions, and local worker tools in HUD workers. */
import { pathToFileURL } from 'node:url';
import { loadBinding, loadRuntime } from '../binding.mjs';
export default async function hud(pi) {
  if (process.env.HUD_JOB_DIR !== undefined) {
    // Explicit worker loads use the launching checkout; installed package loads use their binding.
    const nativeAsk = process.argv.includes('--hud-worker-tools');
    // Print workers have no TUI to deliver an answer into. End only after pi has persisted the tool results.
    if (nativeAsk && process.argv.includes('--print') && process.argv.includes('--session')) {
      pi.on('tool_call', (event) => {
        if (event.toolName === 'hud_ask') event.input.mode = 'sync'; // --qa-timeout 0 publishes without waiting.
      });
      pi.on('tool_result', event => {
        if (event.toolName === 'hud_ask' && !event.isError)
          return { content: [{ type: 'text', text: 'Question recorded. The orchestrator’s answer resumes this session.' }] };
      });
      pi.on('turn_end', (event, ctx) => {
        if (event.toolResults.some(result => result.toolName === 'hud_ask' && !result.isError)) {
          try { capturePiTree(process.env.HUD_JOB_DIR); } finally { ctx.abort(); }
        }
      });
      pi.on('input', (_event, ctx) => {
        if (process.env.HUD_RESUME_SESSION_ID && (ctx.sessionManager.getSessionId() !== process.env.HUD_RESUME_SESSION_ID ||
          ctx.sessionManager.getSessionFile() !== process.argv[process.argv.indexOf('--session') + 1]))
          return { action: 'handled' }; // Never deliver the answer/follow-up into a replacement session.
      });
    }
    const url = nativeAsk
      ? new URL('../../../../packages/hud-mcp/bin/worker-tools.mjs', import.meta.url)
      : pathToFileURL(loadBinding(new URL('../binding.json', import.meta.url)).release + '/packages/hud-mcp/bin/worker-tools.mjs');
    const { callWorkerTool, listWorkerTools, watchSonicReady, capturePiTree, recordStartupShellSession } = await import(url.href);
    const notices = new AbortController();
    const waits = new Set(), pendingReady = new Map();
    pi.on('session_start', () => {
      if (process.env.HUD_TAB_LAUNCH)
        recordStartupShellSession?.(process.env.HUD_JOB_DIR, process.env.HUD_TAB_LAUNCH, process.env.HERDR_PANE_ID);
    });
    pi.on('session_shutdown', () => {
      notices.abort();
      pendingReady.clear();
    });
    function flushReady() {
      for (const [job, send] of pendingReady) {
        if ([...waits].some(({ ids }) => !ids?.length || ids.includes(job))) continue;
        pendingReady.delete(job);
        send();
      }
    }
    for (const { name, description, inputSchema } of await listWorkerTools()) {
      if (name === 'hud_ask' && nativeAsk) continue; // pi-roles supplies the native asynchronous ask.
      pi.registerTool({
        name, label: name, description, parameters: inputSchema, promptSnippet: description,
        async execute(_id, args, signal, _onUpdate, ctx) {
          const wait = name === 'hud_sonic' && args.task === undefined ? { ids: args.wait } : null;
          if (wait) waits.add(wait);
          let value;
          try {
            value = await callWorkerTool(name, args, signal);
            if (wait) for (const { id } of value.reports) pendingReady.delete(id);
          } finally {
            if (wait) {
              waits.delete(wait);
              flushReady();
            }
          }
          if (name === 'hud_sonic' && !wait) {
            watchSonicReady(value.job, notices.signal, (state) => {
              const send = () => pi.sendMessage({
                customType: 'hud-sonic-ready', display: true,
                content: `Sonic ${value.job} ${state}. Collect its result with hud_sonic (wait: ["${value.job}"]).`,
              }, { triggerTurn: true, deliverAs: 'steer' });
              if (state === 'failed') send();
              else {
                // STATUS can wake this watcher before a same-session wait reads the report.
                pendingReady.set(value.job, send);
                flushReady();
              }
            }, (text) => ctx.ui.notify(`Sonic ${value.job}: ${text}`, 'info'));
          }
          return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
            details: value, ...(name === 'hud_report' ? { terminate: true } : {}) };
        },
      });
    }
    return;
  }
  const binding = loadBinding(new URL('../binding.json', import.meta.url));
  const { installPiPackage } = await loadRuntime(binding);
  installPiPackage(pi, binding, {}, 'delegate');
}
