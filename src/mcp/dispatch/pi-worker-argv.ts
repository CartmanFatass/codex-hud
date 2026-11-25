import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Job } from '../job-contracts.js';
import { sonicSession } from '../sonic-session.js';
import type { Role } from '../../roles/roster.js';
import { sonicProtocolTools, writeContract } from '../../harness/pi/worker/contract.js';

export function sonicArgv(home: string, dir: string, job: Job, role: Role, profile: string, resources: string[], prompt: string) {
  if (profile !== 'sonic' && profile !== 'implementer') {
    if (['reviewer', 'architect', 'general'].includes(profile)) throw Error(`Headless Sonic pi_role ${profile} requires the slice 2 role policy`);
    throw Error(`Unknown pi_role for headless Sonic: ${profile}`);
  }
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
  const excluded = ['hud_ask', 'ask_orchestrator', 'hud_sonic'];
  let explicitTools = false;
  for (let i = 0; i < extra.length; i++) {
    const arg = extra[i];
    if (/^--(?:role(?:-bundle)?|hud-[\w-]+)(?:=|$)/.test(arg)) throw Error('pi_args cannot load a legacy role');
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
    const list = value + sonicProtocolTools.map(name => `,${prefix}${name}`).join('');
    extra[i] = equal < 0 ? list : arg.slice(0, equal + 1) + list;
  }
  const flag = (key: string) => {
    for (let i = extra.length - 1; i >= 0; i--) {
      if (extra[i] === `--${key}`) return extra[i + 1];
      if (extra[i].startsWith(`--${key}=`)) return extra[i].slice(key.length + 3);
    }
  };
  const explicitModel = flag('model'), explicitThinking = flag('thinking');
  const model = explicitModel ?? job.model, thinking = explicitThinking ?? job.thinking;
  if (!model || !thinking) throw Error('Missing resolved Sonic model or thinking level');
  const provider = flag('provider');
  writeContract(dir, { version: 1, job: job.job, role: 'sonic', instructions: role.instructions ?? 'sonic',
    model: provider && !model.includes('/') ? `${provider}/${model}` : model, thinking, explicitTools, tps: job.tps !== false });
  if (!explicitModel) args.push('--model', model);
  if (!explicitThinking) args.push('--thinking', thinking);
  return [...args, ...resources, ...extra,
    '--exclude-tools', excluded.join(','), '--session', sonicSession(dir), '--print', '--mode', 'json', '--', prompt];
}
