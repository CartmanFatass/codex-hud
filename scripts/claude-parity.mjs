#!/usr/bin/env node
/** Explicit read-only owner inventory draft. Never discovers or edits a client config. */
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
    'Usage: node RELEASE/claude-parity.mjs preview --home ABS --config ABS\nRead-only draft to stdout. Review and save it under HUD_HOME; pass its path as --parity-inventory during activation.'
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
