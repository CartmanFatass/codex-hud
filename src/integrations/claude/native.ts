/** Corroborated main inference: registry + complete ancestry + foreground TTY + exact pane.
 * Claude's registry has no affirmative topology field. Unknown is never top-level.
 */
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { callerAncestry, liveProbe, type CallerProbe } from '../../roles/caller.js';
import { NativeCallerResolver } from '../../roles/caller-resolve.js';
import { readProcess, sameStamp } from '../../core/run/process.js';
import { processLaunch, workerLaunch, type ProcessLaunch, type NativePanelEvidence } from '../panel/eligibility.js';
import { displayTarget, type PanelContext } from '../panel/receipt.js';
import { CliPanelHerdr, PanelDeadline, type PanelHerdr } from '../panel/herdr.js';
import type { ClaudeBinding } from './binding.js';
export interface NativeCapture {
  context: PanelContext;
  native: NativePanelEvidence;
  herdr: PanelHerdr;
  isCurrent(): boolean;
}
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function nonInteractive(p: ProcessLaunch): boolean {
  return (
    workerLaunch(p) ||
    p.argv.some((v) =>
      /^(?:--print(?:=|$)|-p|--input-format(?:=|$)|--output-format(?:=|$)|--sdk-url(?:=|$)|--.*(?:rpc|sdk|stream-json))/.test(
        v
      )
    )
  );
}
export async function captureNative(
  binding: ClaudeBinding,
  env: NodeJS.ProcessEnv,
  deps: {
    probe?: CallerProbe;
    processInfo?: typeof readProcess;
    launch?: typeof processLaunch;
    herdr?: PanelHerdr;
  } = {}
): Promise<NativeCapture> {
  const probe = deps.probe ?? liveProbe(env);
  const processInfo = deps.processInfo ?? readProcess;
  const launch = deps.launch ?? processLaunch;
  const resolver = new NativeCallerResolver(probe);
  const identity = resolver.resolve();
  const found = callerAncestry(probe);
  if (!identity.ok || !found || found.harness !== 'claude') throw new Error('identity_unverified');
  const main = processInfo(found.process.pid);
  if (!main || main.stamp.proc_start !== found.process.procStart) throw new Error('panel_process_unknown');
  const source = probe.realpath(found.process.env.CLAUDE_CONFIG_DIR ?? join(found.process.env.HOME ?? '', '.claude'));
  if (!source) throw new Error('identity_source_missing');
  const ancestry = () => {
    const rows: unknown[] = [];
    let pid = found.process.pid;
    let server = null;
    let worker = false;
    for (let depth = 0; depth < 64 && pid > 1; depth++) {
      const info = processInfo(pid);
      const image = launch(pid);
      if (!info || !image || !image.argv.length) throw new Error('panel_ancestry_unknown');
      if (
        nonInteractive(image) ||
        (pid !== main.stamp.pid &&
          (basename(image.argv[0]) === 'claude' ||
            (['node', 'nodejs'].includes(basename(image.argv[0])) &&
              image.argv.slice(1, 3).some((v) => /\/claude-code\/(?:cli\.js|bin\/)|\/claude(?:\.js)?$/.test(v))))) ||
        image.argv.some((v) => /(?:hud-mcp|pi-dispatch|pi-role|role-contract)/.test(v)) ||
        ['HUD_ROLE', 'HUD_ROLE_CONTRACT', 'HUD_RUN', 'HUD_JOB_ID', 'PI_ROLE', 'PI_ROLE_TASK_DIR'].some(
          (k) => !!image.env[k]
        )
      )
        worker = true;
      if (basename(image.argv[0]) === 'herdr') server = info.stamp;
      rows.push([info.stamp, info.ppid, image.argv, worker]);
      if (info.ppid >= pid && info.ppid === pid) throw new Error('panel_ancestry_unknown');
      pid = info.ppid;
    }
    if (pid !== 1) throw new Error('panel_ancestry_unknown');
    return { digest: sha(rows), worker, server };
  };
  const chain = ancestry();
  if (chain.worker) throw new Error('panel_worker_session');
  if (!main.tty || main.foregroundPgid !== main.pgid) throw new Error('panel_process_unknown');
  if (!env.HERDR_PANE_ID || !env.HERDR_SOCKET_PATH || !chain.server) {
    if (!deps.herdr) throw new Error('panel_origin_unverified');
  }
  const herdr = deps.herdr ?? new CliPanelHerdr({ socket: env.HERDR_SOCKET_PATH!, server: chain.server!, env });
  const deadline = new PanelDeadline(450);
  try {
    const instance = await herdr.instance(deadline);
    const origin = await herdr.observe(env.HERDR_PANE_ID ?? '', deadline);
    if (!instance || !origin || !sameStamp(origin.process, main.stamp)) throw new Error('panel_origin_unverified');
    const isCurrent = () => {
      try {
        resolver.assertCurrent(identity);
        const now = processInfo(main.stamp.pid);
        return (
          !!now &&
          sameStamp(now.stamp, main.stamp) &&
          now.tty === main.tty &&
          now.foregroundPgid === now.pgid &&
          ancestry().digest === chain.digest
        );
      } catch {
        return false;
      }
    };
    if (!isCurrent()) throw new Error('stale_context');
    return {
      context: {
        target: displayTarget('claude', identity.identity.root.sessionId, source),
        main: main.stamp,
        instance,
        origin,
        runtime: { node: binding.node, entry: join(binding.release, 'bin/hud'), digest: binding.digest },
      },
      native: { identity: identity.identity, topology: 'top-level', ui: 'tui', verified: true },
      herdr,
      isCurrent,
    };
  } finally {
    deadline.dispose();
  }
}
