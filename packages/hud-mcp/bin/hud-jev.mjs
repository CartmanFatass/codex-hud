#!/usr/bin/env node
/** One visible browser CLI job. The CLIs own the browser, keys and send-once rules. */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordFailureExhaustion } from '../dist/src/roles/roster.js';

const dir = process.argv[2];
const bundled = fileURLToPath(new URL('..', import.meta.url));
const hudHome = dirname(dirname(resolve(dir)));
let job;
try {
  job = JSON.parse(fs.readFileSync(join(dir, 'job.json'), 'utf8'));
} catch (error) {
  console.error(`Cannot read browser job: ${error.message}`);
  process.exit(1);
}
const role = job.bro ?? job.jev,
  output = join(dir, 'report.md'),
  brief = join(dir, 'brief.md');
const started = new Date().toISOString();
function status(state, reason = null) {
  const time = new Date().toISOString();
  const value = {
    version: 1,
    task_dir: dir,
    slot: 'primary',
    role: job.role,
    harness: 'bro',
    provider: role.provider === 'chatgpt' ? 'openai' : 'gemini',
    pid: process.pid,
    model: role.model ?? null,
    thinking: role.thinking ?? null,
    state,
    output_path: output,
    output_written: state === 'closed',
    started_at: started,
    updated_at: time,
    ended_at: state === 'working' ? null : time,
    settled_at: state === 'working' ? null : time,
    exit_reason: reason,
    error: state === 'failed' ? reason : null,
  };
  const statusFile = join(dir, 'STATUS.json');
  fs.writeFileSync(`${statusFile}.${process.pid}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(`${statusFile}.${process.pid}.tmp`, statusFile);
}
let active,
  stopped = false;
process.once('SIGTERM', () => {
  stopped = true;
  active?.kill('SIGTERM');
});
async function cli(command, args) {
  if (stopped) throw new Error('external shutdown: SIGTERM');
  console.log(`> ${command} ${args.join(' ')}`);
  return new Promise((done, reject) => {
    const child = (active = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }));
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (data) => {
      process.stdout.write(data);
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      process.stderr.write(data);
      stderr = (stderr + data).slice(-4096);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? done(stdout.trim())
        : reject(new Error(`${command} exited ${code}: ${stderr || stdout.slice(-4096)}`))
    );
  });
}
let failure = null;
status('working');
try {
  if (role.tool === 'jev-ask') {
    const provider = ['--provider', role.provider];
    const raw = await cli(role.tool, ['key', ...provider, '--label', job.job, '--prompt-file', brief]);
    const { key } = JSON.parse(raw);
    const send = ['send', ...provider, '--key', key, '--prompt-file', brief, '--conversation', 'new'];
    if (role.effort) send.push('--effort', role.effort);
    await cli(role.tool, send);
    await cli(role.tool, ['wait', ...provider, '--key', key, '--prompt-file', brief, '--answer-file', output]);
  } else if (role.tool === 'jev-aistudio') {
    const args = ['send', '--label', job.job, '--prompt-file', brief, '--out', output];
    for (const key of ['model', 'thinking']) if (role[key]) args.push(`--${key}`, role[key]);
    await cli(role.tool, args);
  } else {
    const kind = role.kind ?? 'image';
    const media = join(dir, 'media');
    fs.mkdirSync(media, { mode: 0o700 });
    const args = ['send', '--label', job.job, '--kind', kind, '--prompt-file', brief, '--out-dir', media];
    if (role.model) args.push('--model', role.model);
    // Only an explicit cost statement in this brief authorizes passing the CLI's credit confirmation.
    const cost = fs.readFileSync(brief, 'utf8').match(/\bcost:\s*(\d+)\s+credits\b/i)?.[1];
    if (kind === 'video' && cost !== undefined) args.push('--confirm-credits', cost);
    await cli(role.tool, args);
    const files = fs.readdirSync(media).filter((file) => fs.statSync(join(media, file)).isFile());
    fs.writeFileSync(
      output,
      '# Flow downloads\n\n' + files.map((file) => `- [${file}](media/${encodeURIComponent(file)})`).join('\n') + '\n',
      { mode: 0o600 }
    );
  }
  if (!fs.existsSync(output)) throw new Error('report missing');
  fs.chmodSync(output, 0o600);
  status('closed', 'settled');
} catch (error) {
  const raw = String(error.message ?? error).replace(/[\r\n]+/g, ' ');
  failure = recordFailureExhaustion(hudHome, bundled, dir, job, raw).reason;
  status('failed', failure);
  process.exitCode = 1;
}
const message = `[${job.role}@${job.job}] ${failure ? `FAILED ${failure}` : `DONE ${output}`}`;
console.log(message);
try {
  await cli('herdr', ['agent', 'prompt', job.herdr_pane, message]);
} catch (error) {
  console.error(`Completion notification failed: ${error.message}`);
}
