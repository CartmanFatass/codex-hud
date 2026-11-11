#!/usr/bin/env node
/** Read-only, current Linux PID namespace only; no cleanup or ownership adoption.
 * Optional --inventory PATH: {"schema":1,"slice":"pi|transports|workbench|runtime",
 * "processes":[{"pid":123,"start_ticks":456,"boot_id":"..."}]}. Stamps are checked,
 * never trusted as a complete resource inventory. Missing proof remains UNKNOWN.
 */
import * as fs from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const slices = ['pi', 'transports', 'workbench', 'runtime'];
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function text(file) {
  if (fs.realpathSync(file) !== file) throw Error('noncanonical');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || !(stat.mode & 0o444) || stat.size > 65536) throw Error('unreadable_or_unbounded');
    const bytes = Buffer.alloc(65537);
    const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (size > 65536) throw Error('oversized');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
  } finally {
    fs.closeSync(fd);
  }
}
function entries(directory) {
  if (fs.realpathSync(directory) !== directory || !fs.statSync(directory).isDirectory()) throw Error('unsafe_dir');
  const names = fs.readdirSync(directory);
  if (names.length > 100000) throw Error('inventory_limit');
  return names;
}
export function processStamp(stamp) {
  if (
    !object(stamp) ||
    !Number.isSafeInteger(stamp.pid) ||
    stamp.pid < 1 ||
    !Number.isSafeInteger(stamp.start_ticks) ||
    stamp.start_ticks < 1 ||
    typeof stamp.boot_id !== 'string' ||
    !stamp.boot_id
  )
    return 'UNKNOWN';
  try {
    if (text('/proc/sys/kernel/random/boot_id').trim() !== stamp.boot_id) return 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
  try {
    const stat = text(`/proc/${stamp.pid}/stat`);
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    if (!/^\d+$/.test(fields[19] ?? '')) return 'UNKNOWN';
    if (Number(fields[19]) !== stamp.start_ticks) return 'PASS'; // reused, not this process
    return ['Z', 'X'].includes(fields[0]) ? 'PASS' : 'FAIL';
  } catch (error) {
    // No signal(0): absence is accepted only in a procfs without hidden PID mounts.
    try {
      if (error.code === 'ENOENT' && !/hidepid=|subset=pid/.test(fs.readFileSync('/proc/mounts', 'utf8')))
        return 'PASS';
    } catch {
      return 'UNKNOWN';
    }
    return 'UNKNOWN';
  }
}
export function audit(argv, emit = console.log) {
  let blocked = false;
  const out = (state, name) => {
    emit(`${state} ${name}`);
    if (state !== 'PASS') blocked = true;
  };
  const args = {};
  for (let n = 0; n < argv.length; n += 2) {
    const key = argv[n];
    if (
      !['--slice', '--home', '--prefix', '--clients', '--inventory'].includes(key) ||
      !argv[n + 1] ||
      argv[n + 1].startsWith('--') ||
      key in args
    ) {
      out('UNKNOWN', 'arguments');
      return 1;
    }
    args[key] = argv[n + 1];
  }
  const slice = args['--slice'],
    home = args['--home'];
  if (!slices.includes(slice) || !home || resolve(home) !== home) {
    out('UNKNOWN', 'arguments');
    return 1;
  }
  try {
    entries(home);
    out('PASS', 'home_readable');
  } catch {
    out('UNKNOWN', 'home_readable');
  }
  if (args['--inventory']) {
    try {
      const inv = JSON.parse(text(args['--inventory']));
      if (
        !object(inv) ||
        inv.schema !== 1 ||
        inv.slice !== slice ||
        !Array.isArray(inv.processes) ||
        inv.processes.length > 1000
      )
        throw Error('invalid_inventory');
      out('PASS', 'inventory_readable');
      inv.processes.forEach((stamp, n) => out(processStamp(stamp), `inventory_process_${n}`));
    } catch {
      out('UNKNOWN', 'inventory_readable');
    }
  }
  const retired = {
    pi: /^(pi-dispatch|pi-role|pi-role-reap)(\.mjs)?$/,
    transports: /^(demo-(codex-exec|claude-print|pi-rpc)(-transport)?|synthetic-client|synthetic-pi)\.mjs$/,
    workbench: /^(unified(-runner|-world)?|vertical(-runner)?|synthetic-(codex|pi|handshake|pi-reporter))(\.mjs)?$/,
    runtime: /^(host-entry|jev-bridge|hud-run|group-leader|main)(\.(js|py|mjs))?$/,
  }[slice];
  try {
    let found = false,
      unknown = false;
    for (const pid of entries('/proc').filter((p) => /^\d+$/.test(p))) {
      try {
        if (
          text(`/proc/${pid}/cmdline`)
            .split('\0')
            .some((arg) => retired.test(basename(arg)))
        )
          found = true;
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes(error.code)) unknown = true;
      }
    }
    out(found ? 'FAIL' : unknown ? 'UNKNOWN' : 'PASS', 'retired_entrypoints');
  } catch {
    out('UNKNOWN', 'retired_entrypoints');
  }
  if (slice === 'pi' || slice === 'runtime') {
    try {
      for (const name of entries(join(home, 'jobs'))) {
        if (name === 'index') continue;
        const r = JSON.parse(text(join(home, 'jobs', name, 'receipt.json')));
        if (!object(r) || r.schema !== 1 || !object(r.binding) || !object(r.executor)) throw Error('invalid_receipt');
        if (r.binding.harness === 'pi' && r.binding.executor === 'herdr') {
          if (r.pi_dispatch?.contract_version !== 2 || r.pi_dispatch?.transport !== 'hud-owned')
            out('UNKNOWN', 'legacy_pi_resources'); // closed/settled is not cleanup proof
        }
      }
      out('PASS', 'receipts_readable');
    } catch {
      out('UNKNOWN', 'receipts_readable');
    }
    out('UNKNOWN', 'owner_herdr_panes_helpers_and_homes');
  }
  if (slice === 'transports' || slice === 'workbench') out('UNKNOWN', 'owner_fixture_children_and_workspaces');
  if (slice === 'runtime') {
    try {
      entries(args['--prefix']);
      out('PASS', 'prefix_readable');
    } catch {
      out('UNKNOWN', 'prefix_readable');
    }
    try {
      const clients = args['--clients']?.split(',');
      if (!clients?.length || clients.some((p) => !p)) throw Error('undisclosed');
      clients.forEach((p) => text(p));
      out('PASS', 'client_files_readable');
    } catch {
      out('UNKNOWN', 'client_files_readable');
    }
    out('UNKNOWN', 'six_role_activation_and_complete_client_scope');
    out('UNKNOWN', 'ledger_claims_slots_native_sockets_browser_handles_and_scopes');
  }
  return blocked ? 1 : 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = audit(process.argv.slice(2));
