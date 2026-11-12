import { spawn } from 'node:child_process';
import { join, isAbsolute, delimiter } from 'node:path';
import { accessSync, realpathSync, constants } from 'node:fs';
import type { HostAdapter } from '../core/interfaces/host-adapter.js';
import type { DelegationViewModel } from '../core/link/view-model.js';
import type { DelegationAction } from '../render/delegation/actions.js';
import { monitorText, wrapped } from '../render/monitor-text.js';

/** Execute only actions captured from the displayed frame. No command is executed. */
export async function dispatchDelegationAction(
  action: Exclude<DelegationAction, { type: 'switch' }>,
  drawn: DelegationViewModel | undefined,
  current: DelegationViewModel | null,
  sameRootAndEpoch: boolean,
  ports: {
    home: string | null;
    copy: (text: string) => Promise<boolean | ClipboardResult>;
    host?: Pick<HostAdapter, 'locate' | 'focus'>;
    isCurrent?: () => boolean;
    open?: () => Promise<string>;
    openLog?: () => boolean;
  }
): Promise<string> {
  if (!sameRootAndEpoch || !drawn || !sameDelegationActionTarget(drawn, current, action.key))
    return 'Selection changed; try again.';
  const node = drawn.tree.nodes.find((item) => item.key === action.key);
  if (!node) return 'Selection changed; try again.';
  if (action.type === 'delegation-diagnostic') return action.text;
  if (action.type === 'delegation-open') {
    if (ports.open) return ports.open();
    if (!ports.host) return 'Open unavailable: no host adapter is connected.';
    if (!node.currentRun || !node.host?.currentState) return 'Open unavailable for this run.';
    try {
      const locator = await ports.host.locate(node.currentRun.runId);
      if (!locator || !ports.isCurrent?.()) return 'Open unavailable: target changed.';
      await ports.host.focus(locator);
      return 'Opened run.';
    } catch {
      return 'Open unavailable for this run.';
    }
  }
  if (action.type === 'delegation-copy') {
    const command = action.descriptor.displayCommand;
    const result = await ports.copy(command);
    if (result === true || result === 'copied') return 'Reconcile command copied.';
    return result === 'unconfirmed' ? `Clipboard unconfirmed: ${command}` : `Not copied: ${command}`;
  }
  if (node.currentRun?.mode !== 'headless' || !ports.home) return 'Log unavailable for this run.';
  return ports.openLog?.() ? 'Log viewer opened.' : 'Log viewer unavailable for this run.';
}

export type ClipboardResult = 'copied' | 'unavailable' | 'unconfirmed';
type ClipboardOptions = { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; timeoutMs?: number; cleanupMs?: number };
const CLIPBOARD_ACK = 'HUD_CLIPBOARD_OK_V1';
// Fixed code only: the command is base64 stdin data, never PowerShell source or argv.
const CLIPBOARD_SCRIPT =
  "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $u=New-Object System.Text.UTF8Encoding($false,$true); $v=$u.GetString($b); [Windows.Forms.Clipboard]::SetText($v,[Windows.Forms.TextDataFormat]::UnicodeText); $r=[Windows.Forms.Clipboard]::GetText([Windows.Forms.TextDataFormat]::UnicodeText); if ([string]::Equals($v,$r,[StringComparison]::Ordinal)) { [Console]::Out.Write('HUD_CLIPBOARD_OK_V1') } else { exit 1 }";

function findPowerShell(env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    try {
      const candidate = realpathSync(join(dir, 'powershell.exe'));
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

/** One owned WSL clipboard process per page. No provider fallback or shell evaluation. */
export function createClipboardProvider(options: ClipboardOptions = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const executable = platform === 'linux' && (env.WSL_INTEROP || env.WSL_DISTRO_NAME) ? findPowerShell(env) : null;
  let blocked = false,
    closed = false,
    active = false;
  let abort: (() => void) | null = null;
  let activeDone: Promise<void> | null = null;
  let resolveActive: (() => void) | null = null;
  return {
    close(): Promise<void> {
      closed = true;
      abort?.();
      return activeDone ?? Promise.resolve();
    },
    async copy(text: string): Promise<ClipboardResult> {
      if (closed || blocked || active || !executable || text.includes('\0')) return 'unavailable';
      const bytes = Buffer.from(text, 'utf8');
      if (bytes.length > 256 * 1024 || bytes.toString('utf8') !== text || !bytes.length) return 'unavailable';
      active = true;
      activeDone = new Promise<void>((resolve) => {
        resolveActive = resolve;
      });
      try {
        return await new Promise<ClipboardResult>((resolve) => {
          let child: ReturnType<typeof spawn>;
          try {
            child = spawn(
              executable,
              ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', CLIPBOARD_SCRIPT],
              { stdio: ['pipe', 'pipe', 'ignore'], env }
            );
          } catch {
            resolve('unavailable');
            return;
          }
          let settled = false,
            submitted = !!child.pid,
            interrupted = false,
            invalidOutput = false,
            inputError = false;
          let output = Buffer.alloc(0);
          let cleanup: ReturnType<typeof setTimeout> | undefined;
          const finish = (result: ClipboardResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (cleanup) clearTimeout(cleanup);
            abort = null;
            resolve(result);
          };
          const stop = () => {
            if (settled || interrupted) return;
            interrupted = true;
            // A WSL bridge close alone cannot prove that a Windows provider stopped.
            blocked = true;
            try {
              child.kill('SIGKILL');
            } catch {}
            cleanup = setTimeout(() => {
              blocked = true;
              finish(submitted ? 'unconfirmed' : 'unavailable');
            }, options.cleanupMs ?? 1000);
          };
          abort = stop;
          const timer = setTimeout(stop, options.timeoutMs ?? 5000);
          child.stdout!.on('data', (chunk: Buffer) => {
            if (output.length + chunk.length > 1024) {
              invalidOutput = true;
              stop();
              return;
            }
            output = Buffer.concat([output, chunk]);
          });
          child.once('error', () => {
            inputError = true;
          });
          child.stdin!.on('error', () => {
            inputError = true;
          });
          child.once('close', (code) => {
            if (!submitted) {
              finish('unavailable');
              return;
            }
            finish(
              !interrupted && !invalidOutput && !inputError && code === 0 && output.toString('utf8') === CLIPBOARD_ACK
                ? 'copied'
                : 'unconfirmed'
            );
          });
          child.stdin!.end(bytes.toString('base64'));
        });
      } finally {
        active = false;
        resolveActive?.();
        resolveActive = null;
        activeDone = null;
      }
    },
  };
}

/** Only use a picker label when the complete native root tree makes it unique. */
export function delegationPickerLabel(vm: DelegationViewModel | null, rootId: string, id: string): string | undefined {
  if (!vm || vm.tree.coverage.state !== 'complete') return undefined;
  const roots = vm.tree.nodes.filter(
    (n) =>
      n.parentKey === null &&
      n.identity.kind === 'session' &&
      n.identity.ref.harness === 'codex' &&
      n.identity.ref.sessionId === rootId
  );
  if (roots.length !== 1) return undefined;
  const descendants = vm.tree.nodes.filter((n) => {
    let at = n;
    const seen = new Set<string>();
    while (at.parentKey) {
      if (at.edge !== 'native' || seen.has(at.key)) return false;
      seen.add(at.key);
      const parent = vm.tree.nodes.find((p) => p.key === at.parentKey);
      if (!parent) return false;
      at = parent;
    }
    return at.key === roots[0].key && n.key !== at.key;
  });
  const targets = descendants.filter(
    (n) => n.identity.kind === 'session' && n.identity.ref.harness === 'codex' && n.identity.ref.sessionId === id
  );
  const label = id === rootId ? 'Main [default]' : targets.length === 1 ? targets[0].native?.pickerLabel : null;
  if (!label) return undefined;
  const squash = (value: string) => value.replace(/\s+/g, '');
  const labels = ['Main [default]', ...descendants.map((n) => n.native?.pickerLabel).filter((v): v is string => !!v)];
  return labels.filter((candidate) => squash(candidate) === squash(label)).length === 1 ? label : undefined;
}

/** Process the displayed input before invalidating its collection epoch. */
export function withInputRefresh<T>(hasInput: boolean, processInput: () => T, refresh: () => void): T {
  try {
    return processInput();
  } finally {
    if (hasInput) refresh();
  }
}

/** Serialise navigation and publish its completion only while the originating view is current. */
export function createNavigationGate() {
  let busy = false;
  return async function run<T>(
    id: string,
    execute: () => Promise<T>,
    current: () => boolean,
    start: () => void,
    finish: (outcome: { value: T } | { error: unknown }) => void
  ): Promise<boolean> {
    if (!id || busy) return false;
    busy = true;
    try {
      start();
      let outcome: { value: T } | { error: unknown };
      try {
        outcome = { value: await execute() };
      } catch (error) {
        outcome = { error };
      }
      if (current()) finish(outcome);
      return true;
    } finally {
      busy = false;
    }
  };
}

/** A second Open on the same row must not start another host interaction. */
export function createOpenGate() {
  const inFlight = new Set<string>();
  return async (key: string, execute: () => Promise<string>): Promise<string | null> => {
    if (inFlight.has(key)) return null;
    inFlight.add(key);
    try {
      return await execute();
    } finally {
      inFlight.delete(key);
    }
  };
}

/** Compare the identity and command the user saw, allowing equivalent refreshed snapshots. */
export function sameDelegationActionTarget(
  drawn: DelegationViewModel | undefined,
  current: DelegationViewModel | null,
  key: string
): boolean {
  const stamp = (vm: DelegationViewModel | null | undefined) => {
    const node = vm?.tree.nodes.find((item) => item.key === key);
    if (!vm || !node) return null;
    const run = node.currentRun;
    return JSON.stringify({
      ledgerId: vm.tree.ledger.ledgerId,
      identity: node.identity,
      parent: node.parentKey,
      run: run && {
        id: run.runId,
        link: run.linkId,
        seq: run.runSeq,
        generation: run.expectedGeneration,
        mode: run.mode,
        source: run.sourceId,
        harness: run.harness,
        locator: run.locator,
      },
      host: node.host?.locator ?? null,
      descriptor: vm.details[key]?.reconcile ?? null,
    });
  };
  const before = stamp(drawn);
  return before !== null && before === stamp(current);
}

/** Recheck the narrow-pane label after asynchronous navigation begins. */
export function sameDelegationPickerLabel(
  vm: DelegationViewModel | null,
  root: string,
  id: string,
  label: string | undefined
): boolean {
  return delegationPickerLabel(vm, root, id) === label;
}

/** The monitor has at most two notice lines; never present a partial log path as complete. */
export function boundedActionNotice(message: string, width: number): string {
  if (message.startsWith('Not copied: ') || message.startsWith('Clipboard unconfirmed: ')) {
    if (monitorText(message) !== message || wrapped(message, Math.max(1, width - 6)).length > 1)
      return message.startsWith('Not copied: ')
        ? 'Not copied; command not shown.'
        : 'Clipboard unconfirmed; command not shown.';
    return message;
  }
  if (!message.startsWith('Log: ')) return message;
  return wrapped(message, Math.max(1, width - 6)).length > 2 ? 'Log paths too long to display.' : message;
}
