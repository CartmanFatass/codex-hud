/** HUD role tools in main sessions, and local worker tools in HUD workers. */
import { pathToFileURL } from 'node:url';
import { loadBinding, loadRuntime } from '../binding.mjs';
export default async function hud(pi) {
  if (process.env.HUD_JOB_DIR !== undefined) {
    // Explicit worker loads use the launching checkout; installed package loads use their binding.
    const nativeAsk = process.argv.includes('--hud-worker-tools');
    const url = nativeAsk
      ? new URL('../../../../packages/hud-mcp/bin/worker-tools.mjs', import.meta.url)
      : pathToFileURL(loadBinding(new URL('../binding.json', import.meta.url)).release + '/packages/hud-mcp/bin/worker-tools.mjs');
    const { callWorkerTool, listWorkerTools, watchSonicReady } = await import(url.href);
    const notices = new AbortController();
    pi.on('session_shutdown', () => notices.abort());
    for (const { name, description, inputSchema } of await listWorkerTools()) {
      if (name === 'hud_ask' && nativeAsk) continue; // pi-roles supplies the native asynchronous ask.
      pi.registerTool({
        name, label: name, description, parameters: inputSchema, promptSnippet: description,
        async execute(_id, args, signal) {
          const value = await callWorkerTool(name, args, signal);
          if (name === 'hud_sonic' && args.task !== undefined) {
            watchSonicReady(value.job, notices.signal, (state) => pi.sendMessage({
              customType: 'hud-sonic-ready', display: true,
              content: `Sonic ${value.job} ${state}. Collect its result with hud_sonic (wait: ["${value.job}"]).`,
            }, { triggerTurn: true, deliverAs: 'steer' }));
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
