#!/usr/bin/env node
/** Ask the orchestrator from a CLI worker. Same files and texts as pi-roles ask_orchestrator. */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { basename, join } from 'node:path';

const argv = process.argv.slice(2);
const opts = { option: [] };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (!arg.startsWith('--')) {
    positional.push(arg);
    continue;
  }
  const eq = arg.indexOf('=');
  const key = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
  const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
  if (value === undefined || !['dir', 'job-dir', 'question', 'default', 'option', 'context', 'timeout'].includes(key)) {
    process.stderr.write('usage: hud-ask --dir <job-dir> --question <text> --default <text> [--option <text> ...] [--context <text>]\n');
    process.exit(2);
  }
  if (key === 'option') opts.option.push(value);
  else opts[key === 'job-dir' ? 'dir' : key] = value;
}
const dir = opts.dir || process.env.HUD_JOB_DIR || positional[0];
const question = opts.question || positional[1];
const fallback = opts.default ?? positional[2];
if (!dir || !question || fallback === undefined) {
  process.stderr.write('usage: hud-ask --dir <job-dir> --question <text> --default <text> [--option <text> ...] [--context <text>]\n');
  process.exit(2);
}

function questionBody(q) {
  return [
    `# Question q${q.n} from ${q.tag}`,
    '',
    q.question.trim(),
    '',
    ...(q.options?.length ? ['Options:', ...q.options.map((o) => `- ${o}`), ''] : []),
    `Default if unanswered: ${q.default.trim()}`,
    ...(q.context ? ['', `Context: ${q.context.trim()}`] : []),
    '',
    `Answer: write the answer to ${q.afile}`,
    '',
  ].join('\n');
}
function questionLine(q) {
  const oneLine = q.question.replace(/\s+/g, ' ').trim().slice(0, 400);
  const options = q.options?.length ? ` | options: ${q.options.join(' / ')}` : '';
  return `[${q.tag}] QUESTION q${q.n}: ${oneLine}${options} | default: ${q.default.trim()} | full text: ${q.qfile} | reply: write ${q.afile}`;
}
function shellQuote(s) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
function nextQuestionNumber(existing) {
  let highest = 0;
  for (const file of existing) {
    const match = /^q(\d+)(?:\.answer)?\.md$/.exec(file);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}
function publishQuestion(qa, input) {
  let n = nextQuestionNumber(fs.readdirSync(qa));
  for (;;) {
    const q = { ...input, n, qfile: join(qa, `q${n}.md`), afile: join(qa, `q${n}.answer.md`) };
    const answerExistedAtCreation = fs.existsSync(q.afile);
    try {
      fs.writeFileSync(q.qfile, questionBody(q), { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (error.code === 'EEXIST') {
        n++;
        continue;
      }
      throw error;
    }
    return { ...q, answerExistedAtCreation, questionMtimeMs: fs.statSync(q.qfile).mtimeMs };
  }
}
function readQuestionAnswer(q) {
  try {
    const answer = fs.statSync(q.afile);
    if (!answer.isFile() || answer.size === 0 || (q.answerExistedAtCreation && answer.mtimeMs < q.questionMtimeMs)) return undefined;
    return fs.readFileSync(q.afile, 'utf8').trim() || undefined;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}
function sessionValue(key) {
  try {
    const line = fs.readFileSync(join(dir, 'SESSION.txt'), 'utf8').split('\n').find((row) => row.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1) : '';
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

const job = JSON.parse(fs.readFileSync(join(dir, 'job.json'), 'utf8'));
const tag = `${typeof job.role === 'string' ? job.role : 'cli'}@${basename(typeof job.cwd === 'string' && job.cwd ? job.cwd : dir)}`;
const qa = join(dir, 'qa');
fs.mkdirSync(qa, { recursive: true, mode: 0o700 });
const published = publishQuestion(qa, {
  tag,
  question,
  options: opts.option,
  default: fallback,
  ...(opts.context ? { context: opts.context } : {}),
});
let pushed = 'not pushed (no --notify / --orchestrator)';
const orch = sessionValue('ORCH');
if (orch && !/[\u0000-\u001f\u007f-\u009f]/.test(orch)) {
  const command = `herdr agent prompt ${shellQuote(orch)}`;
  const ran = spawnSync('sh', ['-c', `${command} "$1"`, 'pi-role-notify', questionLine(published)], { encoding: 'utf8', timeout: 20000 });
  const detail = ran.error?.message ?? ((ran.stderr || ran.stdout || '').trim().slice(0, 200) || `exit ${ran.status}`);
  pushed = ran.status === 0 ? `pushed via "${command}"` : `notify failed (${detail})`;
}
const timeoutRaw = opts.timeout ?? process.env.HUD_ASK_TIMEOUT;
const timeoutSec = timeoutRaw !== undefined && /^\d+$/.test(String(timeoutRaw)) ? Number(timeoutRaw) : 1200;
const started = Date.now();
let answer;
while (timeoutSec > 0 && Date.now() - started < timeoutSec * 1000) {
  answer = readQuestionAnswer(published);
  if (answer !== undefined) break;
  const left = timeoutSec * 1000 - (Date.now() - started);
  if (left <= 0) break;
  await new Promise((resolve) => setTimeout(resolve, Math.min(2000, left)));
}
const waited = Math.round((Date.now() - started) / 1000);
const text = answer
  ? `ANSWER from the orchestrator (q${published.n}, after ${waited}s):\n\n${answer}`
  : timeoutSec === 0
    ? `Question q${published.n} recorded (${pushed}); not waiting. Proceed with your default: ${fallback.trim()}. Record the open question in your report.`
    : `No answer to q${published.n} within ${timeoutSec}s (${pushed}). Proceed with your default: ${fallback.trim()}. Record the open question in your report.`;
process.stdout.write(text + '\n');
