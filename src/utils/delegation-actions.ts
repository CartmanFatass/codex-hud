import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { lstatSync } from 'node:fs';
import { RunArtifacts } from '../core/run/artifacts.js';
import type { HostAdapter } from '../core/interfaces/host-adapter.js';
import type { DelegationViewModel } from '../core/link/view-model.js';
import type { DelegationAction } from '../render/delegation/actions.js';

/** Execute only actions captured from the displayed frame. No command is executed. */
export async function dispatchDelegationAction(
  action: Exclude<DelegationAction, { type: 'switch' }>,
  drawn: DelegationViewModel | undefined,
  current: DelegationViewModel | null,
  sameRootAndEpoch: boolean,
  ports: {
    home: string;
    copy: (text: string) => Promise<boolean>;
    host?: Pick<HostAdapter, 'locate' | 'focus'>;
    isCurrent?: () => boolean;
  }
): Promise<string> {
  if (!sameRootAndEpoch || !drawn || drawn !== current) return 'Selection changed; try again.';
  const node = drawn.tree.nodes.find((item) => item.key === action.key);
  if (!node) return 'Selection changed; try again.';
  if (action.type === 'delegation-diagnostic') return action.text;
  if (action.type === 'delegation-open') {
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
    return (await ports.copy(command))
      ? 'Reconcile command copied.'
      : `Clipboard unavailable. Reconcile command: ${command}`;
  }
  if (node.currentRun?.mode !== 'headless') return 'Log unavailable for this run.';
  try {
    const artifacts = RunArtifacts.open(ports.home, node.currentRun.runId);
    const file = join(artifacts.directory, 'stdout.log');
    if (!lstatSync(file).isFile()) return 'Log unavailable for this run.';
    artifacts.readLog('stdout', 0, 1);
    return `Log: ${join(artifacts.directory, 'stdout.log')}`;
  } catch {
    return 'Log unavailable for this run.';
  }
}

/** A clipboard helper must acknowledge success; writing an OSC 52 sequence is not an acknowledgement. */
export async function copyDelegationCommand(text: string): Promise<boolean> {
  const program = process.env.WAYLAND_DISPLAY ? 'wl-copy' : 'xclip';
  const args = program === 'xclip' ? ['-selection', 'clipboard'] : [];
  return new Promise((resolve) => {
    const child = spawn(program, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    let settled = false;
    const finish = (ok: boolean) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, 2000);
    child.once('error', () => finish(false));
    child.once('exit', (code) => finish(code === 0));
    child.stdin.on('error', () => finish(false));
    child.stdin.end(text);
  });
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

/** Resolve an activity identity to an unambiguous projected key. */
export function delegationActivityTarget(
  vm: DelegationViewModel,
  rootId: string,
  id: string
): { root: boolean; key: string | null } | null {
  if (id === rootId && rootId) return { root: true, key: null };
  const matches = vm.tree.nodes.filter(
    (node) =>
      node.identity.kind === 'session' && node.identity.ref.harness === 'codex' && node.identity.ref.sessionId === id
  );
  return matches.length === 1 ? { root: false, key: matches[0].key } : null;
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

/** Reveal the target while retaining unrelated folded branches. */
export function revealDelegationAncestors(
  vm: DelegationViewModel,
  key: string,
  collapsed: ReadonlySet<string>
): Set<string> {
  const result = new Set(collapsed);
  let node = vm.tree.nodes.find((item) => item.key === key);
  const seen = new Set<string>();
  while (node?.parentKey && !seen.has(node.parentKey)) {
    seen.add(node.parentKey);
    result.delete(node.parentKey);
    node = vm.tree.nodes.find((item) => item.key === node?.parentKey);
  }
  return result;
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
      },
      host: node.host?.locator ?? null,
      descriptor: vm.details[key]?.reconcile ?? null,
    });
  };
  const before = stamp(drawn);
  return before !== null && before === stamp(current);
}
