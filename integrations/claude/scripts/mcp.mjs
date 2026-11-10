import { pathToFileURL } from 'node:url';
const file = new URL('../binding.json', import.meta.url);
try {
  const { loadPin } = await import('./binding.mjs');
  const pin = loadPin(file);
  const { mcpMain } = await import(pathToFileURL(pin.release + '/dist/integrations/claude/mcp.js').href);
  await mcpMain(pin);
} catch {
  process.stderr.write('hud_mcp_binding_failed\n');
  process.exitCode = 2;
}
