import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { COMMANDS, verifyBundle, copyBundle } from './manifest.mjs';
import { Directory, digest, json, same, exists, identity, listNames } from './safety.mjs';

const HASH = /^[a-f0-9]{64}$/;
const GENERATION = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SELECTOR = 'current';
function selectorSource(prefix, command) {
  return `const prefix = ${JSON.stringify(prefix)};
const [major, minor] = process.versions.node.split('.').map(Number);
if (process.platform !== 'linux' || !((major === 22 && minor >= 13) || major === 24)) throw Error('runtime_unavailable');
if (fs.realpathSync(prefix) !== prefix) throw Error('unsafe_runtime_prefix');
const root = fs.lstatSync(prefix);
if (!root.isDirectory() || (root.mode & 0o7777) !== 0o700 || root.uid !== process.getuid()) throw Error('unsafe_runtime_prefix');
const file = prefix + '/current';
let fd;
try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
catch (error) { if (error.code === 'ENOENT') throw Error('runtime_installation_inactive'); throw error; }
let selected;
try {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 || (stat.mode & 0o7777) !== 0o600 || stat.uid !== process.getuid()) throw Error('unsafe_runtime_selector');
  const bytes = Buffer.alloc(stat.size); let offset = 0;
  while (offset < bytes.length) { const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!read) throw Error('runtime_selector_changed'); offset += read; }
  const after = fs.fstatSync(fd); const named = fs.lstatSync(file);
  if (after.size !== stat.size || after.ctimeMs !== stat.ctimeMs || named.ino !== stat.ino || named.dev !== stat.dev || named.isSymbolicLink()) throw Error('runtime_selector_changed');
  selected = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
} finally { fs.closeSync(fd); }
if (!selected || selected.schemaVersion !== 2 || typeof selected.manifestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(selected.manifestDigest) || typeof selected.generation !== 'string' || !${GENERATION}.test(selected.generation) || JSON.stringify(selected) !== JSON.stringify({schemaVersion: 2, manifestDigest: selected.manifestDigest, generation: selected.generation})) throw Error('runtime_installation_inactive');
const relative = 'releases/' + selected.manifestDigest + '/${COMMANDS[command]}';
const parts = relative.split('/'); let current = prefix;
for (let index = 0; index < parts.length; index++) {
  current += '/' + parts[index]; const stat = fs.lstatSync(current);
  if (stat.uid !== process.getuid() || stat.isSymbolicLink()) throw Error('unsafe_runtime_target');
  if (index + 1 < parts.length) { if (!stat.isDirectory() || (stat.mode & 0o7777) !== 0o700) throw Error('unsafe_runtime_target'); }
  else if (!stat.isFile() || stat.nlink !== 1 || ![0o600,0o700].includes(stat.mode & 0o7777)) throw Error('unsafe_runtime_target');
}
const entry = current;`;
}
const MODULE_MARKER = Buffer.from('{"type":"module"}\n');
function launchArtifacts(prefix) {
  return {
    'package.json': { data: MODULE_MARKER, mode: 0o600 },
    ...Object.fromEntries(
      Object.keys(COMMANDS).map((command) => [command, { data: shim(prefix, command), mode: 0o700 }])
    ),
  };
}
export function shim(prefix, command) {
  if (command === 'codex-hud') return legacyShim(prefix);
  // Syntax-neutral selection reaches refusal under either package scope.
  // Only selection errors are caught; public runMain owns native ESM lifecycle.
  return Buffer.from(`#!/usr/bin/env node
const fs = process.getBuiltinModule('fs');
function selectEntry() {
  const bin = ${JSON.stringify(prefix + '/bin')};
  const binStat = fs.lstatSync(bin);
  if (!binStat.isDirectory() || binStat.isSymbolicLink() || binStat.uid !== process.getuid() || (binStat.mode & 0o7777) !== 0o700) throw Error('unsafe_runtime_bin');
  const marker = bin + '/package.json';
  const markerFd = fs.openSync(marker, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(markerFd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o600 || stat.size !== ${MODULE_MARKER.length}) throw Error('unsafe_runtime_module_marker');
    const bytes = Buffer.alloc(stat.size); let offset = 0;
    while (offset < bytes.length) { const count = fs.readSync(markerFd, bytes, offset, bytes.length - offset, offset); if (!count) throw Error('runtime_module_marker_changed'); offset += count; }
    const after = fs.fstatSync(markerFd); const named = fs.lstatSync(marker);
    for (const value of [after, named]) {
      if (!value.isFile() || value.dev !== stat.dev || value.ino !== stat.ino || value.size !== stat.size || value.ctimeMs !== stat.ctimeMs || value.mtimeMs !== stat.mtimeMs || value.mode !== stat.mode || value.uid !== stat.uid || value.nlink !== stat.nlink) throw Error('runtime_module_marker_changed');
    }
    if (!bytes.equals(Buffer.from(${JSON.stringify(MODULE_MARKER.toString())}))) throw Error('foreign_runtime_module_marker');
  } finally { fs.closeSync(markerFd); }
  ${selectorSource(prefix, command)}
  return entry;
}
let entry;
try { entry = selectEntry(); }
catch (error) { process.stderr.write(error.message + '\\n'); process.exit(5); }
process.argv[1] = entry;
process.getBuiltinModule('module').runMain(entry);
`);
}
function legacyShim(prefix) {
  return Buffer.from(`#!/bin/bash
set -u
selector_pid=''
selector_start=''
selector_reaped=0
selector_wait_status='unknown'
monotonic_ms() {
  local stamp ignored seconds fraction
  IFS=' ' read -r stamp ignored < /proc/uptime || return 1
  [[ "$stamp" =~ ^[0-9]+[.][0-9]+$ ]] || return 1
  seconds="\${stamp%%.*}"; fraction="\${stamp#*.}000"; fraction="\${fraction:0:3}"
  now_ms=$((10#$seconds * 1000 + 10#$fraction))
}
selector_state() {
  local stat rest
  local -a fields
  if IFS= read -r stat 2>/dev/null < "/proc/$selector_pid/stat"; then
    rest="\${stat##*) }"; IFS=' ' read -r -a fields <<< "$rest"
    [[ -n "$selector_start" && "\${fields[19]-}" == "$selector_start" ]] || return 2
    case "\${fields[0]}" in Z|X) return 0 ;; *) return 1 ;; esac
  fi
  [[ ! -e "/proc/$selector_pid" ]] && return 0
  return 2
}
close_selector_pipe() {
  if [[ -n "\${selector_read-}" ]]; then exec {selector_read}<&-; unset selector_read; fi
}
selector_abort() {
  local code="$1" reason="$2" state loops cleanup_deadline
  trap '' INT TERM HUP
  close_selector_pipe
  selector_pid="\${selector_pid:-\${RUNTIME_SELECTOR_PID-}}"
  if [[ "$selector_reaped" == 1 ]]; then
    printf '%s\\n' "runtime_selector_failed: $reason; cleanup=REAPED; owned_pid=$selector_pid; owned_start=$selector_start; wait_status=$selector_wait_status" >&2
    exit "$code"
  fi
  if [[ -z "$selector_pid" ]] || ! monotonic_ms; then
    printf '%s\\n' "runtime_selector_failed: $reason; cleanup=UNKNOWN; owned_pid=$selector_pid; owned_start=$selector_start" >&2
    exit "$code"
  fi
  cleanup_deadline=$((now_ms + 2000))
  selector_state; state=$?
  if [[ "$state" == 1 ]]; then kill -KILL "$selector_pid" 2>/dev/null || :; fi
  for ((loops=0; loops<150; loops++)); do
    monotonic_ms || break
    ((now_ms < cleanup_deadline)) || break
    selector_state; state=$?
    if [[ "$state" == 0 ]]; then
      wait "$selector_pid" 2>/dev/null; selector_wait_status=$?
      if [[ "$selector_wait_status" != 127 ]]; then
        selector_reaped=1
        printf '%s\\n' "runtime_selector_failed: $reason; cleanup=REAPED; owned_pid=$selector_pid; owned_start=$selector_start; wait_status=$selector_wait_status" >&2
        exit "$code"
      fi
      break
    fi
    /usr/bin/sleep 0.02 || break
  done
  printf '%s\\n' "runtime_selector_failed: $reason; cleanup=UNKNOWN; owned_pid=$selector_pid; owned_start=$selector_start; wait_status=$selector_wait_status" >&2
  exit "$code"
}
trap 'selector_abort 130 interrupted_SIGINT' INT
trap 'selector_abort 143 interrupted_SIGTERM' TERM
trap 'selector_abort 129 interrupted_SIGHUP' HUP
monotonic_ms || { printf '%s\\n' 'runtime_selector_clock_unavailable' >&2; exit 5; }
selector_deadline=$((now_ms + 5000))
coproc RUNTIME_SELECTOR { exec node <<'HUD_RUNTIME_SELECTOR_JS'
const fs = require('node:fs');
try {
  ${selectorSource(prefix, 'codex-hud')}
  process.stdout.write(entry + '\\0');
} catch (error) { process.stderr.write(error.message + '\\n'); process.exitCode = 5; }
HUD_RUNTIME_SELECTOR_JS
}
selector_pid=$RUNTIME_SELECTOR_PID
exec {selector_read}<&"\${RUNTIME_SELECTOR[0]}" || selector_abort 5 pipe_unavailable
raw_read=\${RUNTIME_SELECTOR[0]}; exec {raw_read}<&-
raw_write=\${RUNTIME_SELECTOR[1]}; exec {raw_write}>&-
if IFS= read -r stat 2>/dev/null < "/proc/$selector_pid/stat"; then
  rest="\${stat##*) }"; IFS=' ' read -r -a fields <<< "$rest"; selector_start="\${fields[19]-}"
fi
[[ -n "$selector_start" ]] || selector_abort 5 identity_unavailable
monotonic_ms || selector_abort 5 clock_unavailable
remaining=$((selector_deadline - now_ms))
((remaining > 0)) || selector_abort 5 timed_out
printf -v read_timeout '%d.%03d' "$((remaining / 1000))" "$((remaining % 1000))"
entry=''
IFS= read -r -d '' -n 8192 -t "$read_timeout" entry <&"$selector_read" || selector_abort 5 failed_or_timed_out
# A frame alone is not success. Bound terminal-state observation and actual wait
# by the same deadline that began before coproc creation.
for ((loops=0; loops<300; loops++)); do
  monotonic_ms || selector_abort 5 clock_unavailable
  ((now_ms < selector_deadline)) || selector_abort 5 timed_out
  selector_state; state=$?
  if [[ "$state" == 0 ]]; then
    wait "$selector_pid"; selector_wait_status=$?
    [[ "$selector_wait_status" != 127 ]] && selector_reaped=1
    [[ "$selector_wait_status" == 0 ]] || selector_abort 5 nonzero_selector_exit
    monotonic_ms || selector_abort 5 clock_unavailable
    ((now_ms < selector_deadline)) || selector_abort 5 timed_out
    close_selector_pipe
    trap - INT TERM HUP
    exec /bin/bash "$entry" "$@"
  fi
  [[ "$state" == 1 ]] || selector_abort 5 identity_changed
  /usr/bin/sleep 0.02 || selector_abort 5 poll_failed
done
selector_abort 5 iteration_limit
`);
}
function ownedDirectory(directory, name) {
  return directory.withParent(name, (file) => {
    const stat = fs.lstatSync(file);
    if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700)
      throw new Error('unsafe_owned_directory');
    return identity(stat);
  });
}
function readOptional(directory, name) {
  return directory.withParent(name, (file) => exists(file)) ? directory.read(name) : null;
}
export function selectorBytes(target, generation) {
  const bytes = target ? json({ schemaVersion: 2, manifestDigest: target, generation }).toString() : null;
  selectorValue(bytes);
  return bytes;
}
export function selectorValue(bytes) {
  if (bytes === null) return null;
  if (typeof bytes !== 'string') throw new Error('foreign_selector');
  const value = JSON.parse(bytes);
  if (
    !value ||
    value.schemaVersion !== 2 ||
    typeof value.manifestDigest !== 'string' ||
    !HASH.test(value.manifestDigest) ||
    typeof value.generation !== 'string' ||
    !GENERATION.test(value.generation) ||
    !same(value, { schemaVersion: 2, manifestDigest: value.manifestDigest, generation: value.generation })
  )
    throw new Error('foreign_selector');
  return value.manifestDigest;
}
export function inspectPrefix(directory, ignoreLock = false, preparing = false) {
  const names = listNames(directory.base, 6);
  if (names.includes('install-lock') && !ignoreLock) throw new Error('installation_locked_manual_inspection_required');
  if (
    names.some(
      (name) => !['bin', 'releases', 'receipts', 'current', ...(ignoreLock ? ['install-lock'] : [])].includes(name)
    )
  )
    throw new Error('foreign_or_partial_prefix');
  const dirs = {};
  for (const name of ['bin', 'releases', 'receipts'])
    if (names.includes(name)) dirs[name] = ownedDirectory(directory, name);
  const dirCount = Object.keys(dirs).length;
  if (dirCount !== 0 && dirCount !== 3) throw new Error('partial_installation_directories');
  const shims = {};
  if (dirs.bin) {
    if (!same(listNames(`${directory.base}/bin`, 10), Object.keys(launchArtifacts(directory.root)).sort()))
      throw new Error('foreign_or_partial_shims');
    for (const [command, artifact] of Object.entries(launchArtifacts(directory.root))) {
      const file = directory.read(`bin/${command}`);
      if (file.identity.uid !== process.getuid() || file.mode !== artifact.mode || !file.data.equals(artifact.data))
        throw new Error('foreign_shim');
      shims[command] = { sha256: digest(file.data), identity: file.identity };
    }
  }
  const selected = readOptional(directory, SELECTOR);
  if (selected && (selected.identity.uid !== process.getuid() || selected.mode !== 0o600))
    throw new Error('unsafe_selector_mode');
  const current = selected ? selected.data.toString() : null;
  const selectedDigest = selectorValue(current);
  const releases = [];
  if (dirs.releases)
    for (const name of listNames(`${directory.base}/releases`, 64)) {
      if (!HASH.test(name)) throw new Error('partial_or_foreign_release');
      ownedDirectory(directory, `releases/${name}`);
      const installed = verifyBundle(`${directory.root}/releases/${name}`);
      try {
        if (installed.digest !== name) throw new Error('release_digest_mismatch');
      } finally {
        installed.directory.close();
      }
      releases.push(name);
    }
  if (selectedDigest && (!releases.includes(selectedDigest) || !dirs.bin || !dirs.receipts))
    throw new Error('partial_installation');
  const receipts = {};
  if (dirs.receipts)
    for (const name of listNames(`${directory.base}/receipts`, 1024)) {
      if (!name.endsWith('.json') || !GENERATION.test(name.slice(0, -5))) throw new Error('foreign_receipt');
      const read = directory.read(`receipts/${name}`);
      if (read.identity.uid !== process.getuid() || read.mode !== 0o600) throw new Error('unsafe_receipt_mode');
      const value = JSON.parse(read.data);
      if (
        value.schemaVersion !== 2 ||
        !['apply', 'restore', 'stage'].includes(value.operation) ||
        value.transaction !== name.slice(0, -5) ||
        value.prefix !== directory.root ||
        !same(value.prefixIdentity, directory.chain) ||
        !HASH.test(value.bundleDigest) ||
        !HASH.test(value.planDigest) ||
        typeof value.recovery !== 'string'
      )
        throw new Error('foreign_receipt_contents');
      selectorValue(value.before);
      selectorValue(value.after);
      try {
        if (
          value.operation !== 'stage' &&
          value.after !== null &&
          JSON.parse(value.after).generation !== value.transaction
        )
          throw new Error('foreign_receipt_contents');
      } catch {
        throw new Error('foreign_receipt_contents');
      }
      receipts[name] = digest(read.data);
    }
  if (!preparing && dirCount === 3 && (!releases.length || !Object.keys(receipts).length))
    throw new Error('partial_installation_records');
  directory.assert();
  return { dirs, shims, current, currentIdentity: selected?.identity ?? null, releases, receipts };
}
function receiptFor(directory, receiptPath, state) {
  if (typeof receiptPath !== 'string' || path.dirname(receiptPath) !== `${directory.root}/receipts`)
    throw new Error('receipt_must_belong_to_pinned_prefix');
  const bytes = directory.read(`receipts/${path.basename(receiptPath)}`).data;
  const receipt = JSON.parse(bytes);
  if (
    receipt.schemaVersion !== 2 ||
    receipt.operation !== 'apply' ||
    receipt.prefix !== directory.root ||
    !same(receipt.prefixIdentity, directory.chain) ||
    !HASH.test(receipt.bundleDigest) ||
    receipt.after !== state.current ||
    !same(receipt.afterIdentity, state.currentIdentity) ||
    !same(receipt.shims, state.shims)
  )
    throw new Error('stale_or_foreign_receipt');
  const prior = selectorValue(receipt.before);
  if (prior && !state.releases.includes(prior)) throw new Error('previous_release_missing');
  return { path: receiptPath, sha256: digest(bytes), before: receipt.before, prior };
}
export function planInstall(bundleRoot, prefix, restoreReceipt, ignoreLock = false, stageOnly = false) {
  const bundle = verifyBundle(bundleRoot);
  let directory;
  try {
    directory = new Directory(prefix, true);
    const state = inspectPrefix(directory, ignoreLock);
    const restore = restoreReceipt ? receiptFor(directory, restoreReceipt, state) : null;
    const plan = {
      schemaVersion: 1,
      operation: restore ? 'restore' : stageOnly ? 'stage' : 'apply',
      prefix,
      prefixIdentity: directory.chain,
      bundleDigest: bundle.digest,
      state,
      restore,
      target: restore ? restore.prior : bundle.digest,
      noOp:
        !restore &&
        (stageOnly ? state.releases.includes(bundle.digest) : selectorValue(state.current) === bundle.digest),
    };
    if (!plan.noOp) {
      if (Object.keys(state.receipts).length >= 1024) throw new Error('receipt_capacity_exhausted');
      if (plan.operation !== 'restore' && !state.releases.includes(plan.bundleDigest) && state.releases.length >= 64)
        throw new Error('release_capacity_exhausted');
    }
    return { ...plan, planDigest: digest(json(plan)) };
  } finally {
    bundle.directory.close();
    directory?.close();
  }
}
function samePlan(actual, expected) {
  if (!HASH.test(expected) || actual.planDigest !== expected) throw new Error('stale_plan_preview_again');
}
export function executeInstall(bundleRoot, prefix, expected, restoreReceipt, hooks = {}) {
  const stageOnly = hooks.stageOnly === true;
  const plan = planInstall(bundleRoot, prefix, restoreReceipt, false, stageOnly);
  samePlan(plan, expected);
  if (plan.noOp)
    return {
      status: 'NO_OP',
      explanation: 'The identical manifested package is already selected; no files changed.',
      planDigest: expected,
    };
  const directory = new Directory(prefix, true);
  let locked = false;
  let recovery = null;
  let phase = 'preparing';
  try {
    // Atomic mkdir serializes even different bundle installers, without stale-lock guessing.
    locked = true;
    directory.mkdir('install-lock');
    hooks.checkpoint?.('locked');
    const underLock = planInstall(bundleRoot, prefix, restoreReceipt, true, stageOnly);
    samePlan(underLock, expected);
    const id = randomUUID();
    directory.write(
      'install-lock/owner.json',
      json({ schemaVersion: 1, pid: process.pid, transaction: id, planDigest: expected })
    );
    for (const name of ['releases', 'receipts']) if (!plan.state.dirs[name]) directory.mkdir(name);
    if (!restoreReceipt && !plan.state.releases.includes(plan.bundleDigest)) {
      const stage = `releases/staging-${id}`;
      directory.mkdir(stage);
      const bundle = verifyBundle(bundleRoot);
      try {
        copyBundle(bundle, `${prefix}/${stage}`);
      } finally {
        bundle.directory.close();
      }
      hooks.checkpoint?.('staged');
      directory.assert();
      if (exists(`${directory.base}/releases/${plan.bundleDigest}`)) throw new Error('release_already_exists');
      directory.rename(stage, `releases/${plan.bundleDigest}`);
    }
    if (!plan.state.dirs.bin) {
      directory.mkdir('bin');
      // The exact ESM scope marker is durable before any executable launch artifact.
      for (const [name, artifact] of Object.entries(launchArtifacts(prefix)))
        directory.write(`bin/${name}`, artifact.data, artifact.mode);
    }
    const state = inspectPrefix(directory, true, true);
    if (state.current !== plan.state.current || !same(state.currentIdentity, plan.state.currentIdentity))
      throw new Error('selector_changed');
    for (const [name, original] of Object.entries(plan.state.dirs))
      if (!same(state.dirs[name], original)) throw new Error('owned_directory_replaced');
    if (plan.state.dirs.bin && !same(state.shims, plan.state.shims)) throw new Error('shims_changed');
    // Selection identity is one atomic object. A restore selects the exact old
    // release with a new generation, never the old selector bytes or authority.
    const after = stageOnly ? plan.state.current : selectorBytes(plan.target, id);
    if (!stageOnly && after !== null) directory.write(`install-lock/next`, Buffer.from(after));
    const afterIdentity = stageOnly
      ? state.currentIdentity
      : after === null
        ? null
        : directory.read('install-lock/next').identity;
    const receipt = {
      schemaVersion: 2,
      operation: plan.operation,
      transaction: id,
      prefix,
      prefixIdentity: directory.chain,
      bundleDigest: plan.bundleDigest,
      planDigest: expected,
      before: plan.state.current,
      after,
      afterIdentity,
      shims: state.shims,
      recovery:
        'Prepared and fsynced before selection. Inspect current: matching after means selected; matching before means not selected. Any other state is uncertain. Never automatically retry or remove a retained lock.',
    };
    recovery = `${prefix}/receipts/${id}.json`;
    directory.write(`receipts/${id}.json`, json(receipt));
    hooks.checkpoint?.('before-selection');
    directory.assert();
    const finalSource = verifyBundle(bundleRoot);
    try {
      if (finalSource.digest !== plan.bundleDigest) throw new Error('source_changed_before_switch');
    } finally {
      finalSource.directory.close();
    }
    if (plan.target) {
      const finalPayload = verifyBundle(`${prefix}/releases/${plan.target}`);
      try {
        if (finalPayload.digest !== plan.target) throw new Error('payload_changed_before_switch');
      } finally {
        finalPayload.directory.close();
      }
    }
    const immediate = readOptional(directory, SELECTOR);
    if (
      (immediate?.data.toString() ?? null) !== plan.state.current ||
      !same(immediate?.identity ?? null, plan.state.currentIdentity)
    )
      throw new Error('selector_changed_before_switch');
    for (const command of Object.keys(launchArtifacts(prefix))) {
      const read = directory.read(`bin/${command}`);
      if (!same(read.identity, state.shims[command].identity) || digest(read.data) !== state.shims[command].sha256)
        throw new Error('shim_changed_before_switch');
    }
    if (!stageOnly) {
      if (after === null) directory.unlink(SELECTOR);
      else directory.rename('install-lock/next', SELECTOR);
    }
    phase = 'selected';
    hooks.checkpoint?.('after-selection');
    directory.assert();
    const result = {
      status: stageOnly ? 'STAGED' : after === null ? 'INACTIVE' : 'SELECTED',
      receipt: recovery,
      manifestDigest: plan.target,
    };
    // CLI publication is inside the transaction so a failed write retains the barrier.
    hooks.publish?.(result);
    phase = 'finalizing';
    directory.unlink('install-lock/owner.json');
    directory.unlink('install-lock', true);
    locked = false;
    return result;
  } catch (error) {
    let barrier = 'unknown';
    try {
      const present = directory.withParent('install-lock', (file) => exists(file));
      if (present) barrier = 'present';
      else if (phase === 'finalizing') {
        // Selection is never replayed. Restore only the inspection barrier after
        // a successful rmdir followed by a failed directory durability operation.
        try {
          directory.mkdir('install-lock');
          directory.write(
            'install-lock/recovery.json',
            json({ schemaVersion: 1, phase: 'finalization_uncertain', receipt: recovery })
          );
          barrier = 'restored';
        } catch {
          barrier = directory.withParent('install-lock', (file) => exists(file)) ? 'present' : 'absent';
        }
      } else barrier = 'absent';
    } catch {
      barrier = 'unknown';
    }
    if (phase === 'selected' || phase === 'finalizing')
      error.message += `; selection_outcome=${plan.target === null ? 'INACTIVE' : 'SELECTED'}`;
    if (phase === 'finalizing') error.message += `; finalization_uncertain; inspection_barrier=${barrier}`;
    if (locked)
      error.message += `; ${['present', 'restored'].includes(barrier) ? 'installation_locked' : 'lock_state_' + barrier}; inspect_recovery_receipt=${recovery ?? 'not_yet_written'}; do_not_retry`;
    throw error;
  } finally {
    directory.close();
  }
}
