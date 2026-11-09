/** Activation lock ownership only. Reuse the runtime's process-domain/stamp proof. */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Directory, exists, json, same } from './safety.mjs';
const bundledProcess = new URL('../dist/core/run/process.js', import.meta.url);
const { readProcess, processState, sameStamp, currentDomain } = await import(
  exists(fileURLToPath(bundledProcess))
    ? bundledProcess.href
    : new URL('../../dist/core/run/process.js', import.meta.url).href
);
const MANUAL = 'activation_lock_manual_inspection_required';
function readOwner(root) {
  const directory = new Directory(root, true);
  try {
    const value = directory.read('owner.json');
    const owner = JSON.parse(value.data);
    const stamp = owner.stamp;
    if (
      value.mode !== 0o600 ||
      owner.kind !== 'hud-activation-lock' ||
      owner.schemaVersion !== 1 ||
      typeof owner.receipt !== 'string' ||
      !path.isAbsolute(owner.receipt) ||
      !stamp ||
      !Number.isSafeInteger(stamp.pid) ||
      stamp.pid <= 0 ||
      !/^\d+$/.test(stamp.proc_start) ||
      !/^[a-f0-9-]{36}$/.test(stamp.boot_id) ||
      typeof stamp.pid_domain !== 'string' ||
      stamp.pid_domain.length > 1024
    )
      throw new Error('invalid_activation_lock_owner');
    return { owner, identity: directory.chain.at(-1).identity, bytes: value.data };
  } catch {
    throw new Error(`${MANUAL}: ${root}`);
  } finally {
    directory.close();
  }
}
export function refuseActivationLock(prefix, home) {
  for (const root of [path.join(prefix, 'install-lock'), path.join(home, 'installation/activation-lock')]) {
    if (!exists(root)) continue;
    const { owner } = readOwner(root);
    throw new Error(`stale_activation_lock: run hud install restore --receipt ${owner.receipt}; lock=${root}`);
  }
}
function dead(stamp) {
  const domain = currentDomain();
  if (stamp.pid_domain !== domain.pid_domain) return false;
  if (stamp.boot_id !== domain.boot_id) return true;
  return processState(stamp) === 'dead';
}
/** Explicit receipt only; no stale-time heuristic, no signals to an owner/reused PID. */
export function recoverActivationLocks(prefix, home, receipt) {
  const roots = [path.join(prefix, 'install-lock'), path.join(home, 'installation/activation-lock')];
  if (!roots.some(exists)) return;
  const state = new Directory(path.join(home, 'installation'), true);
  let acquired = false;
  try {
    state.mkdir('recovery-lock');
    acquired = true;
    const observed = roots.map((root) => {
      if (!exists(root)) return null;
      const record = readOwner(root);
      if (record.owner.receipt !== receipt) throw new Error(`activation_lock_receipt_mismatch: ${root}`);
      if (!dead(record.owner.stamp)) throw new Error(`activation_lock_owner_alive_or_unknown: ${root}`);
      return record;
    });
    const owners = observed.filter(Boolean);
    if (owners.length === 2 && !same(owners[0].owner, owners[1].owner))
      throw new Error('activation_lock_owners_diverged');
    for (let i = roots.length - 1; i >= 0; i--) {
      if (!observed[i]) continue;
      const now = readOwner(roots[i]);
      if (!same(now.identity, observed[i].identity) || !now.bytes.equals(observed[i].bytes))
        throw new Error('activation_lock_changed');
      const lock = new Directory(roots[i], true);
      try {
        lock.unlink('owner.json');
      } finally {
        lock.close();
      }
      const parent = new Directory(path.dirname(roots[i]), true);
      try {
        parent.unlink(path.basename(roots[i]), true);
      } finally {
        parent.close();
      }
    }
  } finally {
    if (acquired) state.unlink('recovery-lock', true);
    state.close();
  }
}
export function withActivationLocks(prefix, home, receipt, work) {
  const prefixDirectory = new Directory(prefix, true);
  const stateDirectory = new Directory(path.join(home, 'installation'), true);
  const stamp = readProcess(process.pid)?.stamp;
  if (!stamp || !sameStamp(stamp, readProcess(process.pid)?.stamp ?? {}))
    throw new Error('activation_process_identity_unavailable');
  const owner = json({ schemaVersion: 1, kind: 'hud-activation-lock', receipt, stamp });
  let a = false,
    b = false;
  try {
    if (exists(path.join(home, 'installation/recovery-lock'))) throw new Error('activation_recovery_locked');
    prefixDirectory.mkdir('install-lock');
    a = true;
    prefixDirectory.write('install-lock/owner.next', owner);
    prefixDirectory.rename('install-lock/owner.next', 'install-lock/owner.json');
    stateDirectory.mkdir('activation-lock');
    b = true;
    stateDirectory.write('activation-lock/owner.next', owner);
    stateDirectory.rename('activation-lock/owner.next', 'activation-lock/owner.json');
    return work();
  } finally {
    if (b) {
      for (const name of ['owner.json', 'owner.next'])
        if (exists(path.join(home, 'installation/activation-lock', name)))
          stateDirectory.unlink(`activation-lock/${name}`);
      stateDirectory.unlink('activation-lock', true);
    }
    if (a) {
      for (const name of ['owner.json', 'owner.next'])
        if (exists(path.join(prefix, 'install-lock', name))) prefixDirectory.unlink(`install-lock/${name}`);
      prefixDirectory.unlink('install-lock', true);
    }
    prefixDirectory.close();
    stateDirectory.close();
  }
}
