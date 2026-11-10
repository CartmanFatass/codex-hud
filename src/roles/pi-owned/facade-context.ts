/** Trusted facade assembly. Never selected by job JSON, tool arguments, PATH or cwd. */
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installationRoot } from '../../cli/compat.js';
import { callerAncestry, liveProbe, type CallerProbe } from '../caller.js';
import { readProcess, sameStamp } from '../../core/run/process.js';
import { processLaunch } from '../../integrations/panel/eligibility.js';
import { CliPanelHerdr, PanelDeadline, type PanelHerdr } from '../../integrations/panel/herdr.js';
import { readOwnedText, type ReleaseInventory } from './contracts.js';
import type { RuntimeBinding } from './runtime.js';

/** In-process composition only. Not a serialized capability. */
export interface FacadeOwnedContext {
  releaseRoot: string;
  runtime: RuntimeBinding;
}

/** Verify using the running installation's verifier, never code selected by a receipt. */
export async function facadeRelease(
  runningRoot = installationRoot(),
  pin?: { id: string; root: string }
): Promise<ReleaseInventory> {
  try {
    if (basename(dirname(runningRoot)) !== 'releases' || !/^[a-f0-9]{64}$/.test(basename(runningRoot)))
      throw new Error('not_installed');
    const verifier = await import(pathToFileURL(join(runningRoot, 'runtime-package/manifest.mjs')).href);
    const safety = await import(pathToFileURL(join(runningRoot, 'runtime-package/safety.mjs')).href);
    const installer = await import(pathToFileURL(join(runningRoot, 'runtime-package/installer.mjs')).href);
    // This is a retained-release read: integrity comes from its own inventory.
    // PR4's running facade still needs its acquisition capability, independently
    // of what older releases in this prefix were required to ship.
    const running = verifier.verifyBundle(runningRoot, { required: false });
    try {
      if (
        running.digest !== basename(runningRoot) ||
        !running.manifest.entries.some((e: { path: string }) => e.path === 'dist/roles/pi-owned/facade-context.js')
      )
        throw new Error('running_capability_missing');
    } finally {
      running.directory.close();
    }
    const prefix = dirname(dirname(runningRoot));
    const directory = new safety.Directory(prefix, true);
    try {
      const state = installer.inspectPrefix(directory);
      if (!state.releases.includes(basename(runningRoot))) throw new Error('not_installed');
      const root = pin?.root ?? runningRoot;
      if (
        dirname(root) !== join(prefix, 'releases') ||
        (pin && basename(root) !== pin.id) ||
        !state.releases.includes(basename(root))
      )
        throw new Error('owner_missing');
      if (
        !Object.keys(state.receipts).some(
          (name) => JSON.parse(directory.read(`receipts/${name}`).data).bundleDigest === basename(root)
        )
      )
        throw new Error('owner_receipt_missing');
      const bundle = verifier.verifyBundle(root, { required: false });
      try {
        if (bundle.digest !== basename(root) || (pin && bundle.digest !== pin.id)) throw new Error('owner_mismatch');
        return {
          id: bundle.digest,
          root,
          resources: Object.fromEntries(
            bundle.manifest.entries.map((e: { path: string; sha256: string }) => [e.path, e.sha256])
          ),
        };
      } finally {
        bundle.directory.close();
      }
    } finally {
      directory.close();
    }
  } catch {
    throw new Error(pin ? 'pi_owned_owner_unavailable' : 'pi_owned_release_unverified');
  }
}

/** A2 supplies logical identity at admission; this independently corroborates the execution location. */
export async function captureFacadeRuntime(
  env: NodeJS.ProcessEnv,
  deps: {
    probe?: CallerProbe;
    processInfo?: typeof readProcess;
    launch?: typeof processLaunch;
    herdr?: PanelHerdr;
  } = {}
): Promise<RuntimeBinding> {
  const probe = deps.probe ?? liveProbe(env);
  const processInfo = deps.processInfo ?? readProcess;
  const launch = deps.launch ?? processLaunch;
  const caller = callerAncestry(probe);
  if (!caller) throw new Error('caller_pane_unverified');
  const main = processInfo(caller.process.pid);
  if (!main || main.stamp.proc_start !== caller.process.procStart) throw new Error('caller_pane_unverified');
  let pid = main.stamp.pid;
  let server = null;
  const seen = new Set<number>();
  for (let depth = 0; depth < 64 && pid > 1; depth++) {
    if (seen.has(pid)) throw new Error('herdr_unavailable');
    seen.add(pid);
    const info = processInfo(pid);
    const image = launch(pid);
    if (!info || !image) throw new Error('herdr_unavailable');
    if (basename(image.argv[0] ?? '') === 'herdr') {
      server = info.stamp;
      break;
    }
    pid = info.ppid;
  }
  const socket = env.HERDR_SOCKET_PATH;
  if (!server || !socket || !socket.startsWith('/') || /[\0\r\n]/.test(socket)) throw new Error('herdr_unavailable');
  if (!env.HERDR_PANE_ID) throw new Error('caller_pane_unverified');
  const herdr = deps.herdr ?? new CliPanelHerdr({ socket, server, env });
  const deadline = new PanelDeadline(3000);
  try {
    if (!(await herdr.instance(deadline))) throw new Error('herdr_unavailable');
    const pane = await herdr.observe(env.HERDR_PANE_ID, deadline);
    const after = processInfo(main.stamp.pid);
    if (
      !pane ||
      !sameStamp(pane.process, main.stamp) ||
      !after ||
      !sameStamp(after.stamp, main.stamp) ||
      callerAncestry(probe)?.stamp !== caller.stamp
    )
      throw new Error('caller_pane_unverified');
    return { endpoint: { socketPath: socket, server }, callerTabId: pane.tab };
  } finally {
    deadline.dispose();
  }
}

export async function discoverFacadeIntegration(
  env: NodeJS.ProcessEnv,
  runtime: RuntimeBinding,
  budgetMs = 15000
): Promise<{ path: string; version: number }> {
  const { runHerdr } = await import('../herdr-run.js');
  const result = await runHerdr(
    ['integration', 'status'],
    { ...env, HERDR_SOCKET: undefined, HERDR_SOCKET_PATH: runtime.endpoint.socketPath },
    { budgetMs: Math.min(15000, budgetMs) }
  );
  const match = result.ok && /^\s*pi:\s+current\s+\(v([1-9][0-9]*)\)\s+\(([^\r\n]+)\)\s*$/m.exec(result.stdout);
  if (!match) throw new Error('herdr_pi_integration_missing');
  const path = match[2]!;
  const version = Number(match[1]);
  const header = readOwnedText(path, 256 * 1024);
  if (!/HERDR_INTEGRATION_ID=pi\b/.test(header) || !new RegExp(`HERDR_INTEGRATION_VERSION=${version}\\b`).test(header))
    throw new Error('herdr_pi_integration_missing');
  return { path, version };
}
