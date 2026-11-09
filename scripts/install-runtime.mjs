#!/usr/bin/env node
/** Copied to the bundle root. All imported code uses Node builtins only. */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runtime } from './runtime-package/safety.mjs';
import { planInstall, executeInstall } from './runtime-package/installer.mjs';

export const HELP = `Opt-in private runtime installation (Linux, Node 22.13+ within 22.x, or 24.x).
node <bundle>/install-runtime.mjs preview --prefix ABS
node <bundle>/install-runtime.mjs apply --prefix ABS --expect PLAN_DIGEST
node <bundle>/install-runtime.mjs preview --prefix ABS --stage-only yes
node <bundle>/install-runtime.mjs stage --prefix ABS --expect PLAN_DIGEST
Stage retains the previous selector; activate separately with activate-runtime.mjs.
node <bundle>/install-runtime.mjs preview --prefix ABS --restore-receipt ABS
node <bundle>/install-runtime.mjs restore --prefix ABS --receipt ABS --expect PLAN_DIGEST
The prefix must already exist, be canonical, owned by you, and private (0700).
Help and preview write and launch nothing. No default prefix or PATH/provider setup.
Integrity/provenance is not a publisher signature. Inspect the trusted bundle first.
Retained locks require manual inspection, never automatic removal or retry.
`;
function output(bytes) {
  const data = Buffer.from(bytes);
  let written = 0;
  try {
    while (written < data.length) {
      const count = fs.writeSync(1, data, written, data.length - written);
      if (count <= 0) throw new Error('no_output_progress');
      written += count;
    }
  } catch (error) {
    throw new Error(`terminal_output_failed: ${error.code ?? error.message}`);
  }
}
export function main(args = process.argv.slice(2)) {
  if (!args.length || (args.length === 1 && ['--help', 'help', '-h'].includes(args[0]))) {
    output(HELP);
    return;
  }
  runtime();
  const [command, ...rest] = args;
  if (!['preview', 'apply', 'restore', 'stage'].includes(command) || rest.length % 2)
    throw new Error('invalid_arguments; use --help');
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!['--prefix', '--expect', '--receipt', '--restore-receipt', '--stage-only'].includes(key) || key in options)
      throw new Error('invalid_or_duplicate_option');
    options[key] = rest[i + 1];
  }
  if (
    !options['--prefix'] ||
    (options['--stage-only'] &&
      (command !== 'preview' || options['--stage-only'] !== 'yes' || options['--restore-receipt'])) ||
    (command === 'stage' && options['--receipt']) ||
    (command === 'preview' && (options['--expect'] || options['--receipt'])) ||
    (command !== 'preview' && (!options['--expect'] || options['--restore-receipt'])) ||
    (command === 'apply' && options['--receipt']) ||
    (command === 'restore' && !options['--receipt'])
  )
    throw new Error('invalid_arguments; use --help');
  const root = path.dirname(fileURLToPath(import.meta.url));
  let published = false;
  const result =
    command === 'preview'
      ? planInstall(root, options['--prefix'], options['--restore-receipt'], false, options['--stage-only'] === 'yes')
      : executeInstall(root, options['--prefix'], options['--expect'], options['--receipt'], {
          stageOnly: command === 'stage',
          publish(result) {
            output(JSON.stringify(result, null, 2) + '\n');
            published = true;
          },
        });
  if (!published) output(JSON.stringify(result, null, 2) + '\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    try {
      fs.writeSync(2, error.message + '\n');
    } catch {}
    process.exitCode = 1;
  }
}
