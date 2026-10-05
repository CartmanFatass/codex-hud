/**
 * `codex-hud brief --dry-run [file]`: the brief the panel would send now for
 * this directory's Codex session (or CODEX_HUD_CWD's), printed, or written
 * to the file named (private to its owner). Nothing is sent and nothing else
 * is written. See src/collectors/brief-dry-run.ts.
 */
import * as fs from 'node:fs';
import { dryRunText } from './collectors/brief-dry-run.js';
import { runtimeSettings } from './settings-runtime.js';
import { getCodexHome, getHudHome } from './utils/codex-path.js';

const file = process.argv[2];
const result = await dryRunText({ cwd: process.env.CODEX_HUD_CWD || process.cwd(), settings: runtimeSettings(), codexHome: getCodexHome(), hudHome: getHudHome() });
if ('error' in result) {
  process.stderr.write(`codex-hud brief: ${result.error}\n`);
  process.exitCode = 1;
} else if (file) {
  fs.writeFileSync(file, result.text, { mode: 0o600 });
  process.stdout.write(`codex-hud brief: written to ${file} (nothing was sent)\n`);
} else process.stdout.write(result.text);
