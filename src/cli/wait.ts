/**
 * `hud wait --job <id>` normalises one bounded wait. A dispatch job ends on its
 * STATUS settlement; a direct job uses herdr state. It does not accept a result
 * and it does not wake any other session.
 *
 * There is no owner check. Anyone who can read this HUD_HOME can wait on the
 * job. That is acceptable for a local CLI. MCP sessions use `hud_read`, which
 * checks the session root.
 */

import type { HudIO } from './link-export.js';
import { CliError, privateHome } from './private-home.js';
import { waitForJob } from '../roles/job-wait.js';

export const WAIT_USAGE = 'hud wait --job <id> [--timeout-ms N]';

export const WAIT_HELP = `Usage: ${WAIT_USAGE}
       hud wait --help

Wait until the job settles, then print one JSON object. A dispatch job settles on
STATUS idle_grace, closed or failed, on a question, on a corroborated block, or
on the timeout; a direct job uses herdr state. None of those states is
acceptance. Background the command hud_create returns, and re-arm it after an
answer, a fix prompt or a timeout; there is no separate wake broker.

--timeout-ms is optional. A bare 'hud wait' stops after 1800000 ms. The wait
command hud_create returns for a herdr job passes 3600000 ms explicitly. A Jev
job does not return this command. The maximum is 10800000. The value bounds the
wait.

A timeout is not a failure. On a timeout the command prints
{"ok":true,"event":"TIMEOUT",...} with the current observation and exits 6;
re-arm the same command to keep waiting. Exit 4 is a real wait failure, an
unknown job, or an unresolved launch.
HUD_HOME defaults to ~/.hud and must be an absolute, private directory owned by this uid.

Exit codes:
  0  Success or help
  1  Unexpected internal or output failure
  2  Invalid arguments
  3  Invalid, missing, inaccessible, or non-private HUD_HOME
  4  Unknown job, unresolved launch, or a real wait failure
  6  The wait timed out; re-arm the same command
`;

export async function waitCommand(args: readonly string[], io: HudIO): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    await io.stdout(WAIT_HELP);
    return 0;
  }
  let job: string | undefined;
  let timeout: number | null = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--job') {
      job = args[++index];
      if (!job) throw new CliError('invalid_arguments');
    } else if (arg === '--timeout-ms') {
      const raw = args[++index];
      if (!raw || !/^\d+$/.test(raw)) throw new CliError('invalid_arguments');
      timeout = Number(raw);
      if (!Number.isSafeInteger(timeout) || timeout > 10_800_000) throw new CliError('invalid_arguments');
    } else {
      throw new CliError('invalid_arguments');
    }
  }
  if (!job) throw new CliError('invalid_arguments');
  const result = await waitForJob(privateHome(io.env), io.env, job, timeout);
  await io.stdout(`${JSON.stringify(result)}\n`);
  return !result.ok ? 4 : result.event === 'TIMEOUT' ? 6 : 0;
}
