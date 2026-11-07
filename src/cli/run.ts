import { CallBudget } from '../ledger/call-budget.js';
import { join } from 'node:path';
import { validateRequestKey } from '../core/execution.js';
import { HeadlessRunControl } from '../core/run/control.js';
import { LedgerRunFactPort } from '../core/run/ledger-port.js';
import { createShippedManagedCapabilityVerifier } from '../core/launch/capability.js';
import type { CapabilityVerifier } from '../core/launch/capability.js';
import type { LocalResumeRequest } from '../core/types/lifecycle.js';
import type { HudIO } from './link-export.js';
import {
  CliError,
  delegateConfig,
  existingLedger,
  identifier,
  installationRoot,
  mcpModule,
  options,
  integer,
  type LocalResumeService,
  type ResumeServiceOptions,
} from './runtime.js';
import { discoverExecutable, HUD_REVISION } from './capability.js';
import { parseWait, runWait } from './run-wait.js';

export const RUN_USAGE = new Map([
  ['status', 'hud run status <runId> [--json]'],
  ['cancel', 'hud run cancel <runId> [--grace ms] [--json]'],
  ['reconcile', 'hud run reconcile <runId> [--json]'],
  [
    'resume',
    'hud run resume <linkId> --request-key KEY --expected-run RUN --mode headless|visible [--prompt TEXT] [--json]',
  ],
  [
    'wait',
    `hud run wait (<runId> | --link <linkId>) [--after-seq N] [--until report,run_terminal,uncertain]
                    [--owner-generation N] [--timeout-ms ms] [--notify | --json]\n       hud run wait --native-owner JSON [--connection ID] [--after-seq N] [--timeout-ms ms] [--notify | --json]`,
  ],
]);

export const RUN_HELP = `Usage: ${[...RUN_USAGE.values()].join('\n       ')}

Use an existing absolute, canonical, private HUD_HOME owned by this uid (default ~/.hud).
Resume uses the original B4 writer and requires verified capability evidence. It never impersonates the parent.
Native wait observes the authenticated owner's host result/request pointers, not ledger task state.
Run it through Claude's native background-task facility for task notifications; MCP output alone does not wake Claude.
Use --json to receive throughSeq and pass your previous cursor with --after-seq on the next wait.
Native wait timeout, interrupt or frontend disconnect never cancels the child backend.
Legacy wait is read-only, defaults to 2 hours, and checks the parent process every 2 seconds; ledger/watch recovery is every 29 seconds.
Wait JSON emits one metadata page; event bodies and paths are omitted. Drain with runId/nextSeq while hasMore=true.
Notify emits one bounded line; use your own delegate_wait cursor. A deadline is not cancellation.
Visible cancellation currently accepts intent but cannot deliver a signal; stop the run in its pane.
Exit codes: 0 success; 1 internal/dependency failure; 2 invalid input; 3 unsafe HUD_HOME;
4 refused/missing target or orphaned/stale waiter; 5 unsupported runtime/schema; 130 SIGINT; 143 SIGTERM.
`;

export function parseResume(args: readonly string[]): LocalResumeRequest {
  const linkId = identifier(args[0]);
  const flags = options(args.slice(1), ['--json'], ['--request-key', '--expected-run', '--mode', '--prompt']);
  const request_key = flags.get('--request-key');
  try {
    validateRequestKey(request_key as string);
  } catch {
    throw new CliError('invalid_request_key');
  }
  if (typeof request_key !== 'string') throw new CliError('invalid_request_key');
  const expectedRun = identifier(flags.get('--expected-run') as string | undefined);
  const mode = flags.get('--mode');
  if (mode !== 'headless' && mode !== 'visible') throw new CliError('invalid_mode');
  const prompt = flags.get('--prompt');
  if (typeof prompt === 'string' && Buffer.byteLength(prompt) > 65_536) throw new CliError('prompt_too_large');
  return { linkId, request_key, expectedRun, mode, ...(typeof prompt === 'string' ? { prompt } : {}) };
}

/** No environment/config input may supply a verifier. B14 can inject one in its test composition. */
export async function runCommand(
  args: readonly string[],
  home: string,
  io: HudIO,
  trusted: {
    callBudget?: CallBudget;
    capability?: CapabilityVerifier;
    resumeService?: (options: ResumeServiceOptions) => LocalResumeService;
  } = {}
): Promise<number> {
  const [command, ...rest] = args;
  const budget = ['resume', 'cancel'].includes(command) ? (trusted.callBudget ?? new CallBudget()) : undefined;
  budget?.check();
  if (command === 'wait') return runWait(parseWait(rest), home, io);
  if (command === 'resume') {
    const request = parseResume(rest);
    const config = await delegateConfig(home);
    const { ledger } = await existingLedger(home, true, budget);
    let service: LocalResumeService | undefined;
    try {
      const { DelegationService } = await mcpModule('delegation');
      budget?.check();
      const backend = await ledger.readSnapshot(
        (tx) => tx.get('SELECT backend FROM links WHERE link_id=?', request.linkId)?.backend,
        budget
      );
      budget?.check();
      const profile = config.profiles.find((p) => p.name === backend);
      const template = request.mode === 'headless' ? profile?.resumeHeadless : profile?.resume;
      // Trusted startup discovery is reusable by release attestation. It is not
      // itself local-initiation capability evidence (oracle-1, sections 4-5).
      const executable =
        !trusted.capability && template ? await discoverExecutable(template, { ...io.env, ...profile?.env }) : null;
      budget?.check();
      const serviceOptions = {
        ledger,
        home,
        callBudget: budget,
        config,
        env: io.env,
        hudRunPath: join(installationRoot(), 'bin/hud-run'),
        ...(executable?.resolved && executable.version
          ? { executableIdentity: { path: executable.resolved, version: executable.version } }
          : {}),
        capability:
          trusted.capability ??
          createShippedManagedCapabilityVerifier({
            hudRevision: HUD_REVISION,
            versions: {
              hudRevision: HUD_REVISION,
              harness: executable?.version ?? 'unverified',
              host: 'none',
              shell: 'none',
              node: process.versions.node,
              platform: process.platform,
              kernel: 'unverified',
              mcpClient: 'unverified',
            },
          }),
      };
      service = trusted.resumeService ? trusted.resumeService(serviceOptions) : new DelegationService(serviceOptions);
      await io.stdout(JSON.stringify(await service!.resumeLocal(request)) + '\n');
      return 0;
    } finally {
      service?.close();
      await ledger.close();
    }
  }
  if (!['status', 'cancel', 'reconcile'].includes(command)) throw new CliError('invalid_command');
  const runId = identifier(rest[0]);
  const flags = options(rest.slice(1), ['--json'], command === 'cancel' ? ['--grace'] : []);
  const grace = flags.has('--grace') ? integer(String(flags.get('--grace')), 60_000) : 10_000;
  const { ledger, gate } = await existingLedger(home, command !== 'status', budget);
  try {
    const port = new LedgerRunFactPort(ledger, gate);
    const control = new HeadlessRunControl(port, home, gate.actor());
    let value: unknown;
    if (command === 'cancel') {
      const mode = (await port.read(runId, budget)).run.mode;
      budget?.check();
      const intent = await port.acceptCancel(runId, gate.actor(), grace, budget);
      let status = null;
      try {
        status = await control.status(runId);
      } catch {
        /* committed intent remains authoritative */
      }
      value = {
        ok: true,
        accepted: intent !== null,
        cancelRequestedAt: intent?.at ?? null,
        status,
        ...(intent !== null && mode === 'visible'
          ? { code: 'visible_scope_control_unavailable', cancellation: 'unconfirmed' }
          : {}),
      };
    } else value = command === 'status' ? await control.status(runId) : await control.reconcile(runId);
    await io.stdout(JSON.stringify(value) + '\n');
    return 0;
  } finally {
    await ledger.close();
  }
}
