/** Six local pi-roles tools, newline-delimited JSON-RPC over stdio. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const hudHome = resolve(process.env.HUD_HOME || join(homedir(), '.hud'));
const jobsRoot = join(hudHome, 'jobs');
interface Role {
  role: string;
  harness: 'pi';
  pi_role: string;
  split: boolean;
  can_continue: boolean;
}
function roles(): Map<string, Role> {
  const result = new Map<string, Role>();
  // The compiled server lives at dist/packages/hud-mcp/src/ within this package.
  for (const root of [fileURLToPath(new URL('../../../../roles/', import.meta.url)), join(hudHome, 'roles')]) {
    for (const file of entries(root).filter((file) => file.endsWith('.json'))) {
      const role = json<Partial<Role>>(join(root, file));
      if (
        !role ||
        typeof role.role !== 'string' ||
        !role.role.trim() ||
        role.harness !== 'pi' ||
        typeof role.pi_role !== 'string' ||
        !role.pi_role.trim() ||
        typeof role.split !== 'boolean' ||
        typeof role.can_continue !== 'boolean'
      )
        throw new Error(`invalid_role: ${join(root, file)}`);
      result.set(role.role, role as Role);
    }
  }
  return result;
}
interface Job {
  job: string;
  role: string;
  request_key: string;
  cwd: string;
  herdr_pane: string;
  created_at: string;
  dispatch_exit_code: number | null;
  stderr_tail: string;
  message_keys: string[];
  send_outcomes?: { key: string; exit_code: number | null; stderr_tail: string }[];
}
type Args = Record<string, unknown>;
const text = { type: 'string' };
const tool = (name: string, description: string, properties: Args, required: string[] = []) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
});
const tools = [
  tool('hud_roster', 'List local roles and their availability.', {}),
  tool(
    'hud_create',
    'Dispatch a local pi role; request_key deduplicates jobs.',
    { role: text, request_key: text, task: text, cwd: text },
    ['role', 'request_key', 'task']
  ),
  tool('hud_read', 'Read a job, optionally waiting for settlement or a question; omit job for the 20 newest.', {
    job: text,
    wait_ms: { type: 'integer', minimum: 0, maximum: 120000 },
  }),
  tool(
    'hud_send',
    'Continue an eligible role during idle_grace; message_key deduplicates sends.',
    { job: text, message_key: text, text },
    ['job', 'message_key', 'text']
  ),
  tool('hud_respond', 'Write a question answer once.', { job: text, request_id: text, answer: text }, [
    'job',
    'request_id',
    'answer',
  ]),
  tool('hud_close', 'Reap a job with pi-role-reap; safe to repeat.', { job: text }, ['job']),
];

function required(args: Args, key: string): string {
  if (typeof args[key] !== 'string' || !args[key]) throw new Error(`invalid_arguments: ${key}`);
  return args[key] as string;
}
function json<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function entries(directory: string): string[] {
  try {
    return fs.readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
function slice(file: string, limit: number): { text: string; truncated: boolean } | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(limit + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return { text: buffer.subarray(0, Math.min(size, limit)).toString('utf8'), truncated: size > limit };
  } finally {
    fs.closeSync(fd);
  }
}
function directory(job: string): string {
  return join(jobsRoot, job);
}
function save(job: Job): void {
  const file = join(directory(job.job), 'job.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(job, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
function jobs(): Job[] {
  return entries(jobsRoot)
    .filter((id) => /^j[0-9a-f]{16}$/.test(id))
    .map((id) => json<Job>(join(directory(id), 'job.json')))
    .filter((job): job is Job => job !== null);
}
function primary(dir: string): string | null {
  return (
    slice(join(dir, 'SESSION.txt'), 16384)
      ?.text.match(/^PRIMARY=(.*)$/m)?.[1]
      ?.trim() || null
  );
}
function created(job: Job) {
  const task_dir = directory(job.job);
  return { job: job.job, task_dir, agent: primary(task_dir) };
}
function run(command: string, argv: string[]): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8').on('data', (data: string) => {
      stdout = (stdout + data).slice(-4096);
    });
    child.stderr.setEncoding('utf8').on('data', (data: string) => {
      stderr = (stderr + data).slice(-4096);
    });
    child.on('error', (error) => {
      stderr = (stderr + error.message).slice(-4096);
    });
    child.on('close', (code) => done({ exit_code: code ?? -1, stdout, stderr }));
  });
}
function observation(job: Job) {
  const dir = directory(job.job);
  const status = json<{ state?: string; exit_reason?: string | null }>(join(dir, 'STATUS.json'));
  const report = slice(join(dir, 'report.md'), 65536);
  const qa = join(dir, 'qa');
  const questions = entries(qa)
    .filter((name) => /^q\d+\.md$/.test(name))
    .filter((name) => !fs.existsSync(join(qa, name.replace('.md', '.answer.md'))))
    .sort()
    .map((name) => ({ id: name.slice(0, -3), text: slice(join(qa, name), 2048)?.text ?? '' }));
  return {
    job: job.job,
    role: job.role,
    state: status?.state ?? (job.dispatch_exit_code !== null && job.dispatch_exit_code !== 0 ? 'failed' : null),
    dispatch_exit_code: job.dispatch_exit_code,
    stderr_tail: job.stderr_tail,
    exit_reason: status?.exit_reason ?? null,
    report_exists: report !== null,
    report: report?.text ?? null,
    report_truncated: report?.truncated ?? false,
    questions,
  };
}
async function call(name: string, args: Args): Promise<unknown> {
  if (name === 'hud_roster')
    return {
      roles: [...roles().values()].map((role) => ({ ...role, available: true })),
    };
  if (name === 'hud_create') {
    const role = required(args, 'role');
    const definition = roles().get(role);
    if (!definition) return { ok: false, code: 'role_unavailable' };
    const request_key = required(args, 'request_key');
    const existing = jobs().find((job) => job.request_key === request_key);
    if (existing) return created(existing);
    if (!process.env.HERDR_PANE_ID) return { ok: false, code: 'herdr_required' };
    const task = required(args, 'task');
    const cwd = resolve(args.cwd === undefined ? process.cwd() : required(args, 'cwd'));
    const job: Job = {
      job: 'j' + randomBytes(8).toString('hex'),
      role,
      request_key,
      cwd,
      herdr_pane: process.env.HERDR_PANE_ID,
      created_at: new Date().toISOString(),
      dispatch_exit_code: null,
      stderr_tail: '',
      message_keys: [],
    };
    const dir = directory(job.job);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Workers end without writing a file unless told where; pi-dispatch fails a job whose report is missing.
    const brief = `${task}\n\nWrite your final answer to ${join(dir, 'report.md')}; the job fails without that file.\n`;
    fs.writeFileSync(join(dir, 'brief.md'), brief, { flag: 'wx', mode: 0o600 });
    // Persist before dispatch: an interrupted launch must not dispatch again on retry.
    save(job);
    const argv = [definition.pi_role, '--task-dir', dir, '--workdir', cwd, '--output', join(dir, 'report.md')];
    if (definition.split) argv.push('--split');
    const result = await run('pi-dispatch', argv);
    job.dispatch_exit_code = result.exit_code;
    job.stderr_tail = result.stderr;
    save(job);
    return created(job);
  }
  if (name === 'hud_read' && args.job === undefined)
    return {
      jobs: jobs()
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 20)
        .map((job) => ({ job: job.job, role: job.role, state: observation(job).state, created_at: job.created_at })),
    };
  if (!tools.some((tool) => tool.name === name)) throw new Error('unknown_tool');
  const id = required(args, 'job');
  const job = /^j[0-9a-f]{16}$/.test(id) ? json<Job>(join(directory(id), 'job.json')) : null;
  if (!job) return { ok: false, code: 'job_not_found' };
  const dir = directory(job.job);
  if (name === 'hud_read') {
    if (args.wait_ms !== undefined && (typeof args.wait_ms !== 'number' || !Number.isFinite(args.wait_ms)))
      throw new Error('invalid_arguments: wait_ms');
    const end = Date.now() + Math.max(0, Math.min(120000, (args.wait_ms as number | undefined) ?? 0));
    while (true) {
      const result = observation(job);
      if (
        ['idle_grace', 'closed', 'failed'].includes(result.state ?? '') ||
        result.questions.length ||
        Date.now() >= end
      )
        return result;
      await sleep(Math.min(500, end - Date.now()));
    }
  }
  if (name === 'hud_send') {
    const key = required(args, 'message_key');
    const message = required(args, 'text');
    if (job.message_keys.includes(key)) {
      const outcome = job.send_outcomes?.find((outcome) => outcome.key === key);
      return outcome?.exit_code === 0
        ? { ok: true, sent: false }
        : { ok: false, sent: false, code: 'send_failed', ...outcome };
    }
    const agent = primary(dir);
    if (!roles().get(job.role)?.can_continue || observation(job).state !== 'idle_grace' || !agent)
      return { ok: false, code: 'not_continuable' };
    // Record the attempt first, so a lost reply cannot cause a duplicate prompt.
    job.message_keys.push(key);
    const outcome = { key, exit_code: null as number | null, stderr_tail: '' };
    (job.send_outcomes ??= []).push(outcome);
    save(job);
    // agent prompt types the text and submits it with Enter.
    const result = await run('herdr', ['agent', 'prompt', agent, message]);
    outcome.exit_code = result.exit_code;
    outcome.stderr_tail = result.stderr;
    save(job);
    return {
      ...(result.exit_code === 0 ? {} : { code: 'send_failed' }),
      ok: result.exit_code === 0,
      sent: result.exit_code === 0,
      exit_code: result.exit_code,
      stderr_tail: result.stderr,
    };
  }
  if (name === 'hud_respond') {
    const request = required(args, 'request_id');
    if (!/^q\d+$/.test(request)) throw new Error('invalid_arguments: request_id');
    const answer = required(args, 'answer');
    fs.mkdirSync(join(dir, 'qa'), { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(join(dir, 'qa', `${request}.answer.md`), answer, { flag: 'wx', mode: 0o600 });
      return { ok: true, written: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return { ok: true, written: false };
    }
  }
  const result = await run('pi-role-reap', [dir]);
  return {
    exit_code: result.exit_code,
    last_line: (result.stdout.trim() || result.stderr.trim()).split('\n').at(-1) ?? '',
  };
}

// Serialize mutations within this server; waiting reads do not block answers or other calls.
let mutations: Promise<unknown> = Promise.resolve();
const write = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const rpcError = (id: unknown, code: number, message: string) =>
  write({ jsonrpc: '2.0', id, error: { code, message } });
async function receive(line: string): Promise<void> {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    rpcError(null, -32700, 'Parse error');
    return;
  }
  if (
    !request ||
    request.jsonrpc !== '2.0' ||
    typeof request.method !== 'string' ||
    (request.id !== undefined && request.id !== null && !['string', 'number'].includes(typeof request.id))
  ) {
    rpcError(null, -32600, 'Invalid Request');
    return;
  }
  if (request.id === undefined) return; // Includes notifications/initialized.
  let result: unknown;
  switch (request.method) {
    case 'initialize':
      result = {
        protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'hud-mcp-thin', version: '0.1.0' },
      };
      break;
    case 'ping':
      result = {};
      break;
    case 'tools/list':
      result = { tools };
      break;
    case 'tools/call': {
      const name = request.params?.name;
      const args = request.params?.arguments ?? {};
      if (typeof name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) {
        rpcError(request.id, -32602, 'Invalid params');
        return;
      }
      const invoke = () => call(name, args);
      try {
        const value =
          name === 'hud_read' || name === 'hud_roster'
            ? await invoke()
            : await (mutations = mutations.then(invoke, invoke));
        result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
      } catch (error) {
        result = {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                code: 'tool_error',
                error: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
          isError: true,
        };
      }
      break;
    }
    default:
      rpcError(request.id, -32601, 'Method not found');
      return;
  }
  write({ jsonrpc: '2.0', id: request.id, result });
}
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  void receive(line);
});
