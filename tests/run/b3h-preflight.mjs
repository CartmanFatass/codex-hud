// Test-only dependency fault injection before production modules are loaded.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync, chmodSync } from 'node:fs';
const original = childProcess.spawnSync;
const replacement = `${process.env.HUD_HOME}/synthetic-env`;
if (process.env.B3H_ENV_FAULT === 'non-gnu') {
  writeFileSync(replacement, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  chmodSync(replacement, 0o700);
}
childProcess.spawnSync = (path, args, options) => original(path === '/usr/bin/env' ? replacement : path, args, options);
syncBuiltinESMExports();
await (await import('../../dist/core/run/cli.js')).main(['start']).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
