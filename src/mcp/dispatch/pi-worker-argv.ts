import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Job } from '../job-contracts.js';
import { sonicSession } from '../sonic-session.js';
import type { Role } from '../../roles/roster.js';
import { sessionProtocolTools, sonicProtocolTools, writeContract } from '../../harness/pi/worker/contract.js';
import { isPiProfile, piProfileError, piRoleDefaults } from '../../roles/pi-defaults.js';

export function piWorkerArgv(home: string, dir: string, job: Job, role: Role, profile: string | undefined, resources: string[], prompt: string, session?: string) {
  if (!isPiProfile(profile)) throw Error(piProfileError);
  const sonic = job.role === 'sonic';
  const protocols = sonic ? sonicProtocolTools : sessionProtocolTools;
  const borrowed = job.borrowed_instructions;
  const selected = piRoleDefaults[profile], borrowedProfile = isPiProfile(borrowed?.pi_role) ? piRoleDefaults[borrowed.pi_role] : undefined;
  const requested = borrowed?.name ?? role.instructions ?? role.role;
  const name = requested === 'architect' ? 'oracle' : requested;
  const instructions = /^[\w-]+$/.test(name) && existsSync(new URL(`../../../packages/hud-mcp/instructions/${name}.md`, import.meta.url))
    ? name : (borrowed ? borrowedProfile : selected)?.instructions;
  if (!instructions) throw Error('Missing bundled pi worker instructions');
  // Borrowing changes the prompt and can tighten, but never relax, the selected place's guard.
  const guardModes = [selected.guard, borrowedProfile?.guard];
  const guard = guardModes.includes('strict') || job.role === 'reviewer' || instructions === 'reviewer' ? 'strict'
    : guardModes.includes('oracle') || job.role === 'oracle' || instructions === 'oracle' ? 'oracle' : undefined;
  const installed = join(home, 'pi-worker', 'hud-worker.mjs');
  const ext = existsSync(installed) ? installed : fileURLToPath(new URL('../../../integrations/pi/worker/hud-worker.mjs', import.meta.url));
  if (!statSync(ext).isFile()) throw Error(`Invalid pi worker entry: ${ext}`);
  const args = ['-ne', ...(job.skills ? [] : ['-ns']), '-np', '--no-themes', '--no-mcp', '-e', ext];
  const extra = [...(job.pi_args ?? [])];
  const mcp = job.mcp ?? (Boolean(role.mcp_servers?.length) || extra.some(arg => /^--mcp-config(?:=|$)/.test(arg)));
  for (const pkg of [...(mcp ? ['pi-mcp-adapter'] : []), ...(job.lens ? ['pi-lens'] : [])]) {
    const path = join(home, 'pi-worker', 'optional', pkg);
    if (!existsSync(path)) throw Error(`Requested pi worker attachment is missing: ${path}`);
    args.push('-e', path);
  }
  const excluded = sonic ? ['hud_ask', 'ask_orchestrator', 'hud_sonic'] : ['ask_orchestrator'];
  let explicitTools = false;
  for (let i = 0; i < extra.length; i++) {
    const arg = extra[i];
    if (/^--(?:role(?:-bundle)?|hud-[\w-]+)(?:=|$)/.test(arg)) throw Error('pi_args cannot load a legacy role');
    if (arg === '--' || /^(?:-[cpr]|--(?:no-session|continue|resume|fork|session(?:-id|-dir)?|print|mode|task-dir|dispatch-slot|role-output|qa-dir|qa-timeout))(?:=|$)/.test(arg))
      throw Error('pi_args cannot override the headless session lifecycle');
    const placement = /^(--(?:model|provider|thinking))=(.*)$/.exec(arg);
    if (placement) {
      extra.splice(i, 1, placement[1]!, placement[2]!);
      i++;
      continue;
    }
    if (/^(?:--exclude-tools|-xt)(?:=|$)/.test(arg)) {
      const inline = arg.includes('=');
      const value = inline ? arg.slice(arg.indexOf('=') + 1) : extra[i + 1];
      if (!value) throw Error('--exclude-tools needs a tool list');
      excluded.push(value);
      extra.splice(i--, inline ? 1 : 2);
      continue;
    }
    if (!/^(?:--tools|-t)(?:=|$)/.test(arg)) continue;
    explicitTools = true;
    const equal = arg.indexOf('=');
    const value = equal < 0 ? extra[++i] : arg.slice(equal + 1);
    if (!value) throw Error('--tools needs a tool list');
    const prefix = /^\s*[+-]/.test(value) ? '+' : '';
    const list = value + protocols.map(name => `,${prefix}${name}`).join('');
    if (equal < 0) extra[i] = list;
    else { extra.splice(i, 1, arg.slice(0, equal), list); i++; }
  }
  const flag = (key: string) => {
    for (let i = extra.length - 1; i >= 0; i--) {
      if (extra[i] === `--${key}`) return extra[i + 1];
    }
  };
  const explicitModel = flag('model'), explicitThinking = flag('thinking');
  const model = explicitModel ?? job.model ?? undefined, thinking = explicitThinking ?? job.thinking ?? undefined;
  const provider = flag('provider');
  if (!sonic && !session) throw Error('Missing pi worker session file');
  writeContract(dir, { version: 1, job: job.job, role: job.role, instructions, guard, session,
    model: provider && model && !model.includes('/') ? `${provider}/${model}` : model, thinking, explicitTools, tps: job.tps !== false });
  if (model && explicitModel === undefined) args.push('--model', model);
  if (thinking && explicitThinking === undefined) args.push('--thinking', thinking);
  return [...args, ...resources, ...extra, '--exclude-tools', excluded.join(','),
    '--session', session ?? sonicSession(dir), '--print', '--mode', 'json', '--', prompt.startsWith('@') ? ` ${prompt}` : prompt];
}
