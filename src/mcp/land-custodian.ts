/** Detached observer and payload-group leader. Both control channels close when their owner dies. */
import { fork, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { registerLandCustodian, type LandLease } from '../roles/lease.js';
import { isActiveProcState, listProcPids, readProcStat } from '../utils/proc.js';
import { binScript } from './paths.js';

export type Payload = { bin: string; argv: string[]; nodeOptions?: string };
export type Launch = Payload & { lease: LandLease };
export type CommandResult = { code: number | null; signal: NodeJS.Signals | null } | { error: string };
const CLEANUP_WAIT_MS = 4_000;
const TERM_GRACE_MS = 100;

function report(result: CommandResult, sent?: () => void) {
  if (process.connected) process.send!(result, () => sent?.());
  else sent?.();
}

function activeGroup(pid: number, start: string): boolean {
  const leader = readProcStat(pid, { strict: true });
  // Linux retains the PGID while any member exists. A new PID identity proves the old group is gone.
  if (leader && leader.start !== start) return false;
  if (leader && isActiveProcState(leader.state)) return true;
  return listProcPids().some(id => {
    const stat = readProcStat(id, { strict: true });
    return stat && stat.pgrp === pid && stat.session === pid && (isActiveProcState(stat.state) || stat.threads > 1);
  });
}

async function observe({ lease, ...payload }: Launch, stop: Promise<void>, stopping: () => boolean) {
  const settle = await registerLandCustodian(lease, process.ppid);
  let cleanupError: string | undefined;
  try {
    if (stopping()) return;
    const leader = fork(binScript('land-custodian'), ['group'], { detached: true, execArgv: [], silent: true });
    leader.stdout!.pipe(process.stdout, { end: false });
    leader.stderr!.pipe(process.stderr, { end: false });
    let result: CommandResult | undefined;
    let authorized = false;
    leader.on('message', message => {
      if (message === 'started') {
        if (!stopping() && process.connected) process.send!('started', () => {});
        return;
      }
      if (message !== 'ready') { result = message as CommandResult; return; }
      if (stopping() || !leader.connected) return;
      authorized = true;
      leader.send(payload, error => { if (error && leader.connected) leader.disconnect(); });
    });
    const closed = new Promise<void>(done => {
      leader.once('error', error => { result = { error: error.message }; done(); });
      leader.once('close', () => done());
    });
    const pid = leader.pid;
    let start: string | undefined;
    try {
      if (!pid) throw Error('Could not launch the land payload group leader');
      const stat = readProcStat(pid, { strict: true });
      if (stat?.pgrp !== pid || stat.session !== pid || !isActiveProcState(stat.state)) {
        throw Error('Could not verify the land payload group leader');
      }
      start = stat.start;
      await Promise.race([closed, stop]);
    } finally {
      if (leader.connected) leader.disconnect();
      if (authorized && pid && start) {
        try {
          // Only the leader signals. Observe the group after it self-SIGKILLs, including
          // members still executing (e.g. in uninterruptible sleep) after the leader exits.
          const deadline = performance.now() + CLEANUP_WAIT_MS;
          while (activeGroup(pid, start)) {
            const left = deadline - performance.now();
            if (left <= 0) throw Error('group still active after cleanup deadline');
            await delay(Math.min(left, 25));
          }
        } catch (error) {
          cleanupError = `Land custodian PID ${process.pid} could not confirm payload group ${pid} stopped: ${(error as Error).message}`;
        }
      }
      leader.stdout!.destroy();
      leader.stderr!.destroy();
      leader.unref();
      if (cleanupError) throw Error(cleanupError);
    }
    if (result) return result;
    if (!stopping()) throw Error('Land payload group leader exited without a command result');
  } finally {
    await settle(cleanupError);
  }
}

function observer() {
  let stopping = false;
  let stop!: () => void;
  const stopped = new Promise<void>(done => { stop = () => { stopping = true; done(); }; });
  process.on('disconnect', stop);
  process.once('message', launch => {
    process.on('message', message => { if (message === 'timeout') stop(); });
    void observe(launch as Launch, stopped, () => stopping).then(result => {
      if (result) report(result);
    }, error => report({ error: (error as Error).message })).finally(() => {
      if (process.connected) process.disconnect!();
    });
  });
}

function groupLeader() {
  const self = readProcStat(process.pid, { strict: true });
  if (process.pid <= 1 || self?.pgrp !== process.pid || self.session !== process.pid) {
    throw Error('Land payload group leader requires its own session');
  }
  let started = false;
  let stopping = false;
  // SIGTERM includes the leader, which must remain alive to address the same group with SIGKILL.
  process.on('SIGTERM', () => {});
  const cleanup = () => {
    if (!started || stopping) return;
    stopping = true;
    process.kill(-process.pid, 'SIGTERM');
    setTimeout(() => process.kill(-process.pid, 'SIGKILL'), TERM_GRACE_MS);
  };
  process.on('disconnect', cleanup);
  process.once('message', message => {
    if (!process.connected) return;
    const { bin, argv, nodeOptions } = message as Payload;
    started = true;
    const env = nodeOptions === undefined ? process.env : { ...process.env, NODE_OPTIONS: nodeOptions };
    const child = spawn(bin, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    if (process.connected) process.send!('started', () => {});
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    let failure: CommandResult | undefined;
    child.on('error', error => { failure = { error: error.message }; });
    child.once('close', (code, signal) => {
      if (stopping) return;
      // Drain forwarded output before the leader signals itself along with the payload.
      void Promise.all([process.stdout, process.stderr].map(out => new Promise<void>(done => out.write('', () => done()))))
        .then(() => report(failure ?? { code, signal }, cleanup));
    });
  });
}

export function runLandCustodian(mode?: string) {
  // A broken output pipe must not interrupt control-channel cleanup.
  for (const out of [process.stdout, process.stderr]) out.on('error', () => {});
  if (!process.connected) return;
  if (mode === 'group') groupLeader();
  else observer();
  process.send!('ready', () => {});
}
