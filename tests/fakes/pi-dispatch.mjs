#!/usr/bin/env node
/**
 * Fake pi-roles dispatcher pair for role-facade tests. It never starts herdr, a
 * pane, pi, or a model.
 *
 * Invoked as `pi-dispatch`, it:
 *   - appends one JSON line to PI_DISPATCH_LOG with its argv and the notify and
 *     pane variables it received (so a scrubbed parent env is visible as empty);
 *   - checks that the facade already wrote the receipt, the request index, the
 *     association and a non-empty brief, before publishing anything;
 *   - writes a synthetic SESSION.txt and a STATUS.json v1 primary snapshot in
 *     --task-dir, then exits.
 *
 * Invoked as `pi-role-reap` (directly, through a symlink, or through a wrapper
 * named that way), it logs and exits 0, or 1 when PI_REAP_MODE=failed.
 *
 * PI_DISPATCH_MODE:
 *   ok (default)     SESSION and STATUS, exit 0
 *   lost             SESSION and STATUS, exit 1 (the launch happened, the CLI ack did not)
 *   missing-session  nothing written, exit 1
 *   bad-session      malformed SESSION, exit 1
 */

import * as fs from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const scriptName = basename(process.argv[1] ?? '').replace(/\.(?:mjs|cjs|js)$/, '');
// A wrapper execs this file by path, so the wrapper's own name is not in argv[1].
// The reaper contract is `pi-role-reap <task-dir> | --sweep <root> | --help`.
const reapShape =
  argv[0] === '--sweep' ||
  argv[0] === '--help' ||
  argv[0] === '-h' ||
  (argv.length === 1 && !argv[0].startsWith('-')) ||
  process.env.PI_DISPATCH_INVOKED === 'pi-role-reap';
const invoked = scriptName === 'pi-role-reap' || reapShape ? 'pi-role-reap' : scriptName;
const log = process.env.PI_DISPATCH_LOG;

function record(entry) {
  if (!log) return;
  fs.appendFileSync(log, `${JSON.stringify(entry)}\n`);
}

function fail(message) {
  process.stderr.write(`pi-dispatch: ${message}\n`);
  process.exit(1);
}

function option(name) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= argv.length) return null;
  return argv[index + 1];
}

const observed = {
  bin: invoked,
  argv,
  notify: process.env.PI_ROLE_NOTIFY ?? '',
  orchestrator: process.env.PI_ORCHESTRATOR_PANE ?? '',
  herdrPane: process.env.HERDR_PANE_ID ?? '',
};

if (invoked === 'pi-role-reap') {
  record(observed);
  if (process.env.PI_REAP_MODE === 'failed') {
    process.stderr.write('pi-role-reap: synthetic reap failure\n');
    process.exit(1);
  }
  process.exit(0);
}

const role = argv[0] ?? '';
if (!role || role.startsWith('--')) fail('missing role');
const taskArg = option('task-dir');
const workArg = option('workdir');
const outputArg = option('output');
if (!taskArg || !workArg || !outputArg) fail('missing --task-dir/--workdir/--output');

const task = resolve(taskArg);
const work = resolve(workArg);
const output = resolve(outputArg);
const job = basename(task);
const home = process.env.HUD_HOME || dirname(dirname(task));

/** The request index lives under jobs/index/<root-hash>/<key-hash>.json. */
function indexed() {
  const walk = (directory, depth) => {
    if (depth > 4) return false;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (walk(path, depth + 1)) return true;
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          if (JSON.parse(fs.readFileSync(path, 'utf8')).job === job) return true;
        } catch {
          /* An unreadable index entry is not this job's. */
        }
      }
    }
    return false;
  };
  return walk(join(home, 'jobs', 'index'), 0);
}

let briefSize = 0;
try {
  briefSize = fs.statSync(join(task, 'brief.md')).size;
} catch {
  /* Reported as missing below. */
}
const checks = {
  receipt: fs.existsSync(join(task, 'receipt.json')),
  index: indexed(),
  association: fs.existsSync(join(home, 'assoc', `${job}.json`)),
  brief: briefSize > 0,
};
record({ ...observed, task, work, output, checks });

for (const [name, present] of Object.entries(checks)) {
  if (!present) fail(`missing ${name} before dispatch`);
}
const receipt = JSON.parse(fs.readFileSync(join(task, 'receipt.json'), 'utf8'));
if (receipt.pi_dispatch?.launch !== 'sent') fail('launch intent was not persisted before dispatch');
if (fs.existsSync(join(task, 'SESSION.txt')) || fs.existsSync(join(task, 'STATUS.json'))) {
  fail('task already has SESSION.txt or STATUS.json; use a fresh task');
}

const mode = process.env.PI_DISPATCH_MODE || 'ok';
if (mode === 'missing-session') fail('synthetic missing SESSION');

const slug =
  job
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, 20) || 'task';
const session = {
  TASK: job,
  TAB: 'tab1',
  TAB_NAME: `${job}-fake`,
  LEFT: 'pane1',
  RIGHT: argv.includes('--split') ? 'pane2' : '',
  ORCH: process.env.HERDR_PANE_ID ?? process.env.PI_ORCHESTRATOR_PANE ?? '',
  BASE: 'HEAD',
  PRIMARY: `${slug}-primary`,
};
const lines = Object.entries(session)
  .map(([key, value]) => `${key}=${value}\n`)
  .join('');
fs.writeFileSync(join(task, 'SESSION.txt'), mode === 'bad-session' ? `${lines}BROKEN\n` : lines, { mode: 0o600 });
if (mode === 'bad-session') fail('synthetic malformed SESSION');

const now = new Date().toISOString();
const status = {
  version: 1,
  task_dir: fs.realpathSync(task),
  slot: 'primary',
  role,
  model: option('model'),
  thinking: option('thinking'),
  session_id: 'synthetic-session-1',
  session_file: null,
  pid: process.pid,
  output_path: output,
  output_written: false,
  state: 'working',
  helper_pending: null,
  started_at: now,
  settled_at: null,
  idle_deadline_at: null,
  ended_at: null,
  exit_reason: null,
  error: null,
  updated_at: now,
};
fs.writeFileSync(join(task, 'STATUS.json'), `${JSON.stringify(status)}\n`, { mode: 0o600 });

if (mode === 'lost') {
  process.stderr.write('pi-dispatch: synthetic lost acknowledgment\n');
  process.exit(1);
}
process.stdout.write(`pi-dispatch: ${session.PRIMARY} in ${session.TAB} (fake)\n`);
