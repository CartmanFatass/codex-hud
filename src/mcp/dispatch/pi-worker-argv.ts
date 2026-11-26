import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Job } from '../job-contracts.js';
import { sonicSession } from '../sonic-session.js';
import type { Role } from '../../roles/roster.js';
import { sessionProtocolTools, sonicProtocolTools, writeContract } from '../../harness/pi/worker/contract.js';
import { isPiProfile, piProfileError, piRoleDefaults } from '../../roles/pi-defaults.js';

function resolveWorkerEntry(home: string, file: string): string {
  const installed = join(home, 'pi-worker', file);
  const ext = existsSync(installed) ? installed : fileURLToPath(new URL(`../../../integrations/pi/worker/${file}`, import.meta.url));
  if (!statSync(ext).isFile()) throw Error(`Invalid pi worker entry: ${ext}`);
  return ext;
}

function resolveOptionalAttachment(home: string, pkg: string): string {
  for (const candidate of [
    join(home, 'pi-worker', 'optional', pkg),
    join(home, 'pi-worker', 'optional', 'node_modules', pkg),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw Error(`Requested pi worker attachment is missing: ${join(home, 'pi-worker', 'optional', pkg)}`);
}

function herdrAgentStatePath(): string | undefined {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
  const candidate = join(agentDir, 'extensions', 'herdr-agent-state.ts');
  try {
    return statSync(candidate).isFile() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export function piWorkerArgv(
  home: string,
  dir: string,
  job: Job,
  role: Role,
  profile: string | undefined,
  resources: string[],
  prompt?: string,
  session?: string,
  effortSource?: string
) {
  if (!isPiProfile(profile)) throw Error(piProfileError);
  const headless = Boolean(job.headless);
  const sonic = job.role === 'sonic';
  const protocols = sonic ? sonicProtocolTools : sessionProtocolTools;
  const borrowed = job.borrowed_instructions;
  const selected = piRoleDefaults[profile];
  const borrowedProfile = isPiProfile(borrowed?.pi_role) ? piRoleDefaults[borrowed.pi_role] : undefined;
  const tabProfile = borrowed?.pi_role ?? profile;
  if (!headless && !isPiProfile(tabProfile)) throw Error(piProfileError);
  const requested = borrowed?.name ?? role.instructions ?? role.role;
  const name = requested === 'architect' ? 'oracle' : requested;
  const instructions = /^[\w-]+$/.test(name) && existsSync(new URL(`../../../packages/hud-mcp/instructions/${name}.md`, import.meta.url))
    ? name : (borrowed ? borrowedProfile : selected)?.instructions;
  if (!instructions) throw Error('Missing bundled pi worker instructions');
  // Borrowing changes the prompt and can tighten, but never relax, the selected place's guard.
  const guardModes = [selected.guard, borrowedProfile?.guard];
  const guard = guardModes.includes('strict') || job.role === 'reviewer' || instructions === 'reviewer' ? 'strict'
    : guardModes.includes('oracle') || job.role === 'oracle' || instructions === 'oracle' ? 'oracle' : undefined;
  const ext = resolveWorkerEntry(home, 'hud-worker.mjs');
  const args = ['-ne', ...(job.skills ? [] : ['-ns']), '-np', '--no-themes', '--no-mcp', '-e', ext];
  if (!headless) {
    args.push('--tui-mode', 'regular');
    if (job.ui_ext !== false) args.push('-e', resolveWorkerEntry(home, 'hud-worker-ui.mjs'));
    const herdrState = herdrAgentStatePath();
    if (herdrState) args.push('-e', herdrState);
  }
  const advisor = Boolean(job.selection_advisor);
  if (advisor) args.push('--no-context-files', '--no-skills', '--no-tools');
  const extra = advisor ? [] : [...(job.pi_args ?? [])];
  // R2: MCP never auto-loads from ambient MCP config files; only on explicit mcp: true, role mcp_servers, or --mcp-config.
  const mcp = job.mcp ?? (Boolean(role.mcp_servers?.length) || extra.some(arg => /^--mcp-config(?:=|$)/.test(arg)));
  for (const pkg of advisor ? [] : [...(mcp ? ['pi-mcp-adapter'] : []), ...(job.lens ? ['pi-lens'] : [])]) {
    args.push('-e', resolveOptionalAttachment(home, pkg));
  }
  const excluded = sonic ? ['hud_ask', 'ask_orchestrator', 'hud_sonic'] : ['ask_orchestrator'];
  let explicitTools = false;
  for (let i = 0; i < extra.length; i++) {
    const arg = extra[i];
    if (/^--(?:role(?:-bundle)?|hud-[\w-]+)(?:=|$)/.test(arg)) throw Error('pi_args cannot load a legacy role');
    if (/^--(?:orchestrator|notify)(?:=|$)/.test(arg)) throw Error('pi_args cannot override --orchestrator or --notify caller binding');
    if (arg === '--' || (headless
      ? /^(?:-[cpr]|--(?:no-session|continue|resume|fork|session(?:-id|-dir)?|print|mode|task-dir|dispatch-slot|role-output|qa-dir|qa-timeout))(?:=|$)/.test(arg)
      : /^(?:-p|--(?:print|mode|task-dir|dispatch-slot|role-output|qa-dir|qa-timeout))(?:=|$)/.test(arg)))
      throw Error(`pi_args cannot override the ${headless ? 'headless' : 'tab'} session lifecycle`);
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
    const list = value + protocols.map(toolName => `,${prefix}${toolName}`).join('');
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
  if (headless && !sonic && !session) throw Error('Missing pi worker session file');
  writeContract(dir, {
    version: 1,
    job: job.job,
    role: job.role,
    instructions,
    guard,
    session,
    model: provider && model && !model.includes('/') ? `${provider}/${model}` : model,
    thinking,
    explicitTools,
    tps: job.tps !== false,
    ...(!headless && isPiProfile(tabProfile)
      ? { tab: { profile: tabProfile, ...(effortSource ? { effortSource } : {}) } }
      : {}),
  });
  if (model && explicitModel === undefined) args.push('--model', model);
  if (thinking && explicitThinking === undefined) args.push('--thinking', thinking);
  if (!headless) {
    const base = [...args, '--exclude-tools', excluded.join(','), ...resources, ...extra];
    return session ? [...base, '--session', session] : base;
  }
  const base = [...args, ...resources, ...extra, '--exclude-tools', excluded.join(',')];
  if (prompt === undefined) throw Error('Missing headless pi prompt');
  return [...base, '--session', session ?? sonicSession(dir), '--print', '--mode', 'json', '--', prompt.startsWith('@') ? ` ${prompt}` : prompt];
}
