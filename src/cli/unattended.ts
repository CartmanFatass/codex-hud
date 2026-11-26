import { getHudHome } from '../hud-home.js';
import { ticketQueueView } from '../mcp/ticket-queue-state.js';
import { setUnattended } from '../unattended/control.js';
import { readUnattendedDiagnostics, readUnattendedStatus } from '../unattended/state.js';
import type { HudIO } from './hud.js';
import { CliError } from './private-home.js';

const usage = 'Usage: hud unattended on --objective <id> [--objective <id>...] | off | status';

export async function unattendedCommand(args: readonly string[], io: HudIO) {
  if (args[0] === '--help' && args.length === 1) { await io.stdout(`${usage}\n`); return 0; }
  const home = getHudHome(io.env), [op, ...rest] = args;
  try {
    if (op === 'on') {
      if (!rest.length || rest.length % 2 || rest.some((s, i) => i % 2 ? !/^[a-z0-9-]+$/.test(s) : s !== '--objective')) throw Error(usage);
      await setUnattended(home, true, { cwd: process.cwd(), objectives: rest.filter((_, i) => i % 2) }, io.env);
    } else if (rest.length || (op !== 'off' && op !== 'status')) throw Error(usage);
    else if (op === 'off') await setUnattended(home, false, undefined, io.env);
    const { on, identity, control, runs, handbacks } = readUnattendedStatus(home);
    const view = (q: typeof runs[number]) => ({ project: q.root, objective: q.unattended!.objective, ticket: q.unattended!.ticket, ...ticketQueueView(q) });
    await io.stdout(JSON.stringify({ on, ...identity, project: control?.root, objectives: control?.objectives ?? [],
      runs: runs.map(view), handbacks: handbacks.map(view), ...(on && { diagnostics: readUnattendedDiagnostics(home) }) }, null, 2) + '\n');
    return 0;
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error));
  }
}
