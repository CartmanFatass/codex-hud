import { pathToFileURL } from 'node:url';
const lifecycle = process.argv[2] === '--lifecycle';
try {
  const { loadPin } = await import('./binding.mjs');
  const pin = loadPin(new URL('../binding.json', import.meta.url));
  const { hookMain } = await import(pathToFileURL(pin.release + '/dist/integrations/claude/hook.js').href);
  await hookMain(pin, lifecycle);
} catch {
  // Controlled failures emit one document and exit cleanly; the outer command guard
  // discards output from unexpected nonzero/startup failures. Lifecycle never blocks.
  process.stdout.write(
    JSON.stringify(lifecycle ? {} : { decision: 'block', reason: 'HUD: binding_or_hook_failed' }) + '\n'
  );
}
