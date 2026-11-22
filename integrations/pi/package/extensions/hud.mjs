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
    const { callWorkerTool, listWorkerTools } = await import(url.href);
    for (const { name, description, inputSchema } of await listWorkerTools(false)) {
      if (name === 'hud_ask' && nativeAsk) continue; // pi-roles supplies the native asynchronous ask.
      pi.registerTool({
        name, label: name, description, parameters: inputSchema, promptSnippet: description,
        async execute(_id, args, signal) {
          const value = await callWorkerTool(name, args, signal);
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
