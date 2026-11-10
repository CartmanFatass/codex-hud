/** Native identity and top-level UI proof are supplied in-process by the harness package, not hook JSON. */
import * as fs from 'node:fs';
import { sameStamp, readProcess } from '../../core/run/process.js';
import type { CallerIdentity } from '../../roles/caller.js';
import { PanelDeadline, samePane, type PanelHerdr } from './herdr.js';
import { readJson, type PanelContext } from './receipt.js';
import { getHudHome } from '../../hud-home.js';
import { join } from 'node:path';
export interface NativePanelEvidence {
  identity: CallerIdentity;
  topology: 'top-level' | 'worker' | 'unknown';
  ui: 'tui' | 'rpc' | 'print' | 'unknown';
  /** Must be established by native session/launch evidence, not absence of agent_type. */
  verified: boolean;
}
export type Eligibility = { eligible: boolean; diagnostic: string };
export type ProcessLaunch = { argv: readonly string[]; env: NodeJS.ProcessEnv };
export function processLaunch(pid: number): ProcessLaunch | null {
  try {
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    const env: NodeJS.ProcessEnv = {};
    for (const v of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const n = v.indexOf('=');
      if (n > 0) env[v.slice(0, n)] = v.slice(n + 1);
    }
    return { argv, env };
  } catch {
    return null;
  }
}
export function workerLaunch(p: ProcessLaunch): boolean {
  return (
    p.argv.some(
      (v) =>
        ['--hud-role-contract', '--role-bundle', '--agent-id', '--parent-session-id', '--print', '-p'].includes(v) ||
        /^(--hud-role-contract|--role-bundle|--agent-id|--parent-session-id)=/.test(v)
    ) ||
    ['HUD_ROLE_CONTRACT', 'PI_ROLE', 'PI_ROLE_TASK_DIR', 'CLAUDE_CODE_PARENT_SESSION_ID', 'CLAUDE_CODE_AGENT_ID'].some(
      (k) => !!p.env[k]
    )
  );
}
/** Missing preference defaults on. Invalid/unreadable preference does not silently enable auto-open. */
export function autoOpenEnabled(env: NodeJS.ProcessEnv): boolean {
  const config = readJson(join(getHudHome(env), 'integration-config.json'));
  if (config === null) return true;
  if (
    !config ||
    typeof config !== 'object' ||
    typeof (config as { panelAutoOpen?: unknown }).panelAutoOpen !== 'boolean'
  )
    throw new Error('panel_preference_invalid');
  return (config as { panelAutoOpen: boolean }).panelAutoOpen;
}
export async function panelEligibility(
  c: PanelContext,
  h: PanelHerdr,
  d: PanelDeadline,
  evidence: NativePanelEvidence | null,
  launch: (pid: number) => ProcessLaunch | null = processLaunch,
  processInfo: typeof readProcess = readProcess
): Promise<Eligibility> {
  const no = (diagnostic: string): Eligibility => ({ eligible: false, diagnostic });
  if (!evidence?.verified || evidence.topology === 'unknown' || evidence.ui === 'unknown')
    return no('panel_eligibility_unknown');
  if (evidence.topology !== 'top-level' || evidence.ui !== 'tui') return no('panel_worker_or_noninteractive');
  if (
    evidence.identity.harness !== c.target.harness ||
    `${evidence.identity.root.namespace}/${evidence.identity.root.sessionId}` !== c.target.root
  )
    return no('panel_native_context_changed');
  const proc = processInfo(c.main.pid);
  const image = launch(c.main.pid);
  if (!proc || !sameStamp(proc.stamp, c.main) || !proc.tty || !image) return no('panel_process_unknown');
  if (workerLaunch(image)) return no('panel_worker_session');
  if ((await h.instance(d)) !== c.instance) return no('herdr_instance_changed');
  const pane = await h.observe(c.origin.pane, d);
  const after = processInfo(c.main.pid);
  if (
    !pane ||
    !samePane(pane, c.origin) ||
    !sameStamp(pane.process, c.main) ||
    !after ||
    !sameStamp(after.stamp, c.main) ||
    after.tty !== proc.tty ||
    after.foregroundPgid !== after.pgid
  )
    return no('panel_origin_unverified');
  return { eligible: true, diagnostic: 'ok' };
}
