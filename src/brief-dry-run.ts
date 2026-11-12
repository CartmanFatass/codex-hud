/** Compatibility removal notice; no settings, session material or output file is read or written. */
import { dryRunText } from './collectors/brief-dry-run.js';
const result = await dryRunText();
process.stderr.write(`codex-hud brief: ${result.error}\n`);
process.exitCode = 1;
