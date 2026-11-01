#!/usr/bin/env node
// TTY-reading stand-in for the A8 parent-exit row.
//
// It is launched through the 方案甲 supervisor exactly like a harness would be:
// it inherits the pane's terminal, prints a marker, echoes every line it reads
// and exits with a code when it sees the sentinel line. A read error, a closed
// stdin or the timeout exits with 7, so the supervisor receipt distinguishes
// "the stand-in received input" from "it never did".
//
// The probe records only the status file (booleans, counts and synthetic
// markers) and the supervisor receipt. It never records terminal contents.
import fs from 'node:fs';
import readline from 'node:readline';

function parseArgs(argv) {
  const options = { status: '', timeoutMs: 20000, sentinel: 'exit 5', exitCode: 5 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--status') options.status = argv[++i] || '';
    else if (arg === '--timeout-ms') options.timeoutMs = Number(argv[++i]) || options.timeoutMs;
    else if (arg === '--sentinel') options.sentinel = argv[++i] || options.sentinel;
    else if (arg === '--exit-code') options.exitCode = Number(argv[++i]) || options.exitCode;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const startedAt = new Date().toISOString();
let lines = 0;
let sentinelSeen = false;
let readError = null;
let timedOut = false;
let finished = false;

function writeStatus(extra = {}) {
  if (!options.status) return;
  const status = {
    schemaVersion: 1,
    startedAt,
    endedAt: new Date().toISOString(),
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    lines,
    sentinelSeen,
    readError,
    timedOut,
    ...extra,
  };
  const tmp = `${options.status}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`);
  fs.renameSync(tmp, options.status);
}

function finish(code, extra = {}) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  writeStatus(extra);
  process.stdout.write(`STANDIN_EXIT=${code}\n`);
  process.exit(code);
}

process.stdout.write('STANDIN_READY\n');
writeStatus();

const timer = setTimeout(() => {
  timedOut = true;
  finish(7, { reason: 'timeout' });
}, options.timeoutMs);

const rl = readline.createInterface({
  input: process.stdin,
  terminal: process.stdin.isTTY === true,
});
rl.on('line', (line) => {
  lines += 1;
  process.stdout.write(`STANDIN_GOT=${lines}\n`);
  if (line.trim() === options.sentinel) {
    sentinelSeen = true;
    finish(options.exitCode, { reason: 'sentinel' });
    return;
  }
  // Keep the status file current so the probe can see that a line arrived even
  // while the stand-in is still waiting for the sentinel.
  writeStatus({ reason: 'line' });
});
rl.on('close', () => {
  if (!finished) finish(7, { reason: 'stdin-closed' });
});
process.stdin.on('error', (error) => {
  readError = error.code || String(error.message || error);
  finish(7, { reason: 'stdin-error' });
});
