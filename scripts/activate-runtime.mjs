#!/usr/bin/env node
/** Copied to bundle root; also callable before any public HUD command exists. */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activationCommand } from './runtime-package/activation-cli.mjs';
export function main(args = process.argv.slice(2), env = process.env) {
  const result = activationCommand(args, env);
  process.stdout.write(typeof result === 'string' ? result : JSON.stringify(result, null, 2) + '\n');
  if (result.status === 'CONFLICT') process.exitCode = 4;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
