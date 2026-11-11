#!/usr/bin/env node
/** Explicit read-only owner inventory draft, including supported 0.8.0 fields and audited width/tee jobs.
 * Never discovers plugins or edits either client's configuration. Capability is not activation:
 * setup still verifies the explicitly imported HUD section and wrapper argv before allowing apply.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const [verb, homeFlag, home, configFlag, config] = process.argv.slice(2);
if (
  verb !== 'preview' ||
  homeFlag !== '--home' ||
  configFlag !== '--config' ||
  !path.isAbsolute(home ?? '') ||
  !path.isAbsolute(config ?? '') ||
  process.argv.length !== 7
) {
  console.error(
    'Usage: node RELEASE/claude-parity.mjs preview --home ABS --config ABS\nRead-only draft to stdout. Review and save it under HUD_HOME; pass its path as --parity-inventory during activation.\nMigrate explicitly first: hud statusline import --from ABS [--settings ABS] (preview), then --apply. Unknown wrapper jobs remain blocked.'
  );
  process.exitCode = 2;
} else {
  try {
    const directory = path.dirname(fileURLToPath(import.meta.url));
    const root = fs.existsSync(path.join(directory, 'dist/integrations/claude/setup.js'))
      ? directory
      : path.dirname(directory);
    const { draftInventory } = await import(pathToFileURL(path.join(root, 'dist/integrations/claude/setup.js')));
    console.log(JSON.stringify(draftInventory(home, config), null, 2));
  } catch {
    console.error('parity_inventory_preview_failed');
    process.exitCode = 2;
  }
}
