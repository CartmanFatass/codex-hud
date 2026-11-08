#!/usr/bin/env node
/**
 * Fake `pi-role --args-json`. Prints a JSON argv array and does not start pi.
 * The argv is appended to HERDR_FAKE_LOG as { bin: 'pi-role', argv, notify, herdrEnv }.
 * Inherited PI_ROLE_NOTIFY is copied into the array, so a scrubbed parent env
 * is visible as an empty notify.
 */

import * as fs from 'node:fs';

const argv = process.argv.slice(2);
const notify = process.env.PI_ROLE_NOTIFY ?? '';
const herdrEnv = process.env.HERDR_ENV ?? '';
const log = process.env.HERDR_FAKE_LOG;
if (log) fs.appendFileSync(log, `${JSON.stringify({ bin: 'pi-role', argv, notify, herdrEnv })}\n`);
if (argv[0] !== '--args-json') {
  process.stderr.write('pi-role: refusing to start pi\n');
  process.exit(2);
}
const role = argv[1] || '';
const qaAt = argv.indexOf('--qa-dir');
const paneAt = argv.indexOf('--orchestrator');
const words = ['-ne', '-ns', '--role', role];
if (paneAt >= 0 && argv[paneAt + 1]) words.push('--orchestrator', argv[paneAt + 1]);
if (qaAt >= 0 && argv[qaAt + 1]) words.push('--qa-dir', argv[qaAt + 1]);
if (notify) words.push('--notify', notify);
if (herdrEnv === '1') words.push('-e', 'herdr-agent-state');
process.stdout.write(`${JSON.stringify(words)}\n`);
