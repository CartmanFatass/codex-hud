/** In-process pi topology proof. Environment is only an endpoint hint, never identity. */
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { readProcess, sameStamp } from '../../core/run/process.js';
import { processLaunch, workerLaunch } from '../../integrations/panel/eligibility.js';
import { CliPanelHerdr, PanelDeadline, type PanelHerdr } from '../../integrations/panel/herdr.js';
import { displayTarget } from '../../integrations/panel/receipt.js';
import { parseRosterRoot } from '../../roles/selection.js';
import { inspectPiSnapshot, PI_EXTENSION_CONTEXT_PROFILE } from './delegation-context.js';
import type { PiPackageBinding, PiPackageContext } from './package-context.js';
export async function capturePiPanel(
  binding: PiPackageBinding,
  ctx: PiPackageContext,
  env: NodeJS.ProcessEnv,
  isCurrent: () => boolean,
  deps: { processInfo?: typeof readProcess; launch?: typeof processLaunch; herdr?: PanelHerdr; pid?: number } = {}
) {
  if (!ctx.hasUI || ctx.mode !== 'tui') throw Error('panel_noninteractive');
  const pid = deps.pid ?? process.pid;
  const info = deps.processInfo ?? readProcess;
  const launch = deps.launch ?? processLaunch;
  const id = ctx.sessionManager.getSessionId();
  const source = ctx.sessionManager.getSessionDir();
  const header = ctx.sessionManager.getHeader();
  if (!header || header.type !== 'session' || header.id !== id || header.cwd !== ctx.cwd)
    throw Error('panel_native_header_unknown');
  if (header.parentSession) throw Error('panel_nested_session');
  await inspectPiSnapshot(
    {
      profile: PI_EXTENSION_CONTEXT_PROFILE,
      epoch: 'panel',
      toolCallId: 'panel',
      toolName: 'panel',
      sessionId: id,
      sessionDir: source,
      sessionFile: ctx.sessionManager.getSessionFile() ?? null,
    },
    source
  );
  const main = info(pid);
  if (!main?.tty || main.foregroundPgid !== main.pgid) throw Error('panel_process_unknown');
  const ancestry = () => {
    const rows: unknown[] = [];
    let next = pid;
    let server = null;
    for (let depth = 0; depth < 64 && next > 1; depth++) {
      const p = info(next),
        image = launch(next);
      if (!p || !image?.argv.length) throw Error('panel_ancestry_unknown');
      const name = basename(image.argv[0]);
      const isPi =
        name === 'pi' ||
        (['node', 'nodejs'].includes(name) && image.argv.slice(1, 3).some((v) => /\/pi-coding-agent\//.test(v)));
      if (next === pid && !isPi) throw Error('panel_native_process_unknown');
      if (
        workerLaunch(image) ||
        (next !== pid && (isPi || ['claude', 'codex'].includes(name))) ||
        image.argv.some((v) => /(?:hud-mcp|pi-dispatch|pi-role|role-contract)/.test(v)) ||
        ['HUD_ROLE', 'HUD_RUN', 'HUD_JOB_ID', 'PI_ROLE', 'PI_ROLE_TASK_DIR'].some((k) => !!image.env[k])
      )
        throw Error('panel_worker_session');
      if (name === 'herdr') server = p.stamp;
      rows.push([p.stamp, p.ppid, image.argv]);
      if (p.ppid === next) throw Error('panel_ancestry_unknown');
      next = p.ppid;
    }
    if (next !== 1) throw Error('panel_ancestry_unknown');
    return { digest: createHash('sha256').update(JSON.stringify(rows)).digest('hex'), server };
  };
  const chain = ancestry();
  if (!chain.server || !env.HERDR_PANE_ID || !env.HERDR_SOCKET_PATH) throw Error('panel_origin_unverified');
  const herdr = deps.herdr ?? new CliPanelHerdr({ socket: env.HERDR_SOCKET_PATH, server: chain.server, env });
  const deadline = new PanelDeadline(450);
  try {
    const instance = await herdr.instance(deadline);
    const origin = await herdr.observe(env.HERDR_PANE_ID, deadline);
    const current = () => {
      try {
        const p = info(pid),
          h = ctx.sessionManager.getHeader();
        return (
          isCurrent() &&
          ctx.sessionManager.getSessionId() === id &&
          ctx.sessionManager.getSessionDir() === source &&
          h?.id === id &&
          !h.parentSession &&
          !!p &&
          sameStamp(p.stamp, main.stamp) &&
          p.tty === main.tty &&
          p.foregroundPgid === p.pgid &&
          ancestry().digest === chain.digest
        );
      } catch {
        return false;
      }
    };
    if (!instance || !origin || !sameStamp(origin.process, main.stamp) || !current())
      throw Error('panel_origin_unverified');
    const target = displayTarget('pi', id, source);
    return {
      context: {
        target,
        main: main.stamp,
        instance,
        origin,
        runtime: { node: binding.node, entry: join(binding.release, 'bin/hud'), digest: binding.digest },
      },
      native: {
        identity: { harness: 'pi' as const, root: parseRosterRoot(target.root) },
        topology: 'top-level' as const,
        ui: 'tui' as const,
        verified: true,
      },
      herdr,
      isCurrent: current,
    };
  } finally {
    deadline.dispose();
  }
}
