// Explicit test-only composition. No user session or paid CLI; production has no injection flag.
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCommand } from '../../dist/cli/run.js';
import { DelegationService } from '../../packages/hud-mcp/dist/packages/hud-mcp/src/delegation.js';
import { launchPreparedRun } from '../../packages/hud-mcp/dist/src/core/launch/supervisor.js';
const [home, hold] = process.argv.slice(2);
const diagnostic = join(home, 'supervisor-diagnostic.mjs');
writeFileSync(
  diagnostic,
  'import {appendFileSync} from "node:fs";const original=process.stderr.write.bind(process.stderr);process.stderr.write=(data,...args)=>{appendFileSync(' +
    JSON.stringify(join(home, 'supervisor.stderr')) +
    ',data,{mode:0o600});return original(data,...args)};',
  { mode: 0o600 }
);
const trusted = {
  capability: { verify: () => ({ ok: true, reason: null }) },
  resumeService: (options) =>
    new DelegationService({
      ...options,
      launch: async (prepared, ticket) => {
        if (prepared.payload.parent !== undefined) throw new Error('forged_parent');
        const dispatched = await launchPreparedRun(prepared, ticket, {
          hudRunPath: resolve('bin/hud-run'),
          env: { NODE_OPTIONS: '--import ' + pathToFileURL(diagnostic).href },
        });
        writeFileSync(join(home, 'dispatched'), String(dispatched.pid), { mode: 0o600 });
        return dispatched;
      },
    }),
};
const result = await runCommand(
  [
    'resume',
    'link-a',
    '--request-key',
    'b11-real-key',
    '--expected-run',
    'run-a',
    '--mode',
    'headless',
    '--prompt',
    'synthetic supplementary task',
  ],
  home,
  {
    env: { PATH: '/usr/bin:/bin', HOME: home, PWD: home, HUD_HOME: home, CODEX_HOME: home },
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  },
  trusted
);
if (hold) await new Promise((done) => setTimeout(done, 60_000));
process.exitCode = result;
