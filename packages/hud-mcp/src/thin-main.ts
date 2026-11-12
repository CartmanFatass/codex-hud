/** Six local pi-roles tools, newline-delimited JSON-RPC over stdio. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const hudHome = resolve(process.env.HUD_HOME || join(homedir(), '.hud'));
const jobsRoot = join(hudHome, 'jobs');
interface Role {
  role: string;
  harness: 'pi' | 'jev';
  pi_role?: string;
  split?: boolean;
  can_continue?: boolean;
  model?: string;
  thinking?: string;
  tool?: 'jev-ask' | 'jev-aistudio' | 'jev-flow';
  provider?: 'chatgpt' | 'gemini';
  effort?: string;
  kind?: 'image' | 'video';
  source_file: string;
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
        (role.harness !== 'pi' && role.harness !== 'jev') ||
        (role.harness === 'pi' &&
          (typeof role.pi_role !== 'string' ||
            !role.pi_role.trim() ||
            typeof role.split !== 'boolean' ||
            typeof role.can_continue !== 'boolean')) ||
        (role.harness === 'jev' &&
          (!['jev-ask', 'jev-aistudio', 'jev-flow'].includes(role.tool ?? '') ||
            (role.tool === 'jev-ask' && !['chatgpt', 'gemini'].includes(role.provider ?? '')) ||
            (role.tool === 'jev-flow' && !['image', 'video'].includes(role.kind ?? '')))) ||
        ['model', 'thinking', 'effort'].some(
          (key) => role[key as keyof Role] !== undefined && typeof role[key as keyof Role] !== 'string'
        )
      )
        throw new Error(`invalid_role: ${join(root, file)}`);
      result.set(role.role, {
        ...role,
        source_file: join(root, file),
        ...(role.harness === 'jev' ? { can_continue: false } : {}),
      } as Role);
    }
  }
  return result;
}
function executable(command: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const path = resolve(dir, command);
    try {
      fs.accessSync(path, fs.constants.X_OK);
      return fs.realpathSync(path);
    } catch {
      /* Try the next PATH entry. */
    }
  }
  return null;
}
function assignment(role: Role) {
  let pi_role_file: string | null = null;
  if (role.harness === 'pi') {
    for (const command of ['pi-role', 'pi-dispatch']) {
      const bin = executable(command);
      const path = bin && join(dirname(dirname(bin)), 'roles', `${role.pi_role}.md`);
      if (path && fs.existsSync(path)) {
        pi_role_file = path;
        break;
      }
    }
  }
  const frontmatter = pi_role_file && slice(pi_role_file, 16384)?.text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  const effective = (key: 'model' | 'thinking') => {
    if (role[key] !== undefined) return { value: role[key], source: role.source_file };
    const value = frontmatter && frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim();
    return { value: value ? value.replace(/^(['"])(.*)\1$/, '$2') : null, source: value ? pi_role_file : null };
  };
  const model = effective('model'),
    thinking = effective('thinking');
  return {
    ...role,
    model: model.value,
    thinking: thinking.value,
    model_source: model.source,
    thinking_source: thinking.source,
    pi_role_file,
    accepts_options: role.harness === 'pi' ? ['model', 'thinking', ...piSwitches, 'pi_args'] : [],
    available: true,
  };
}
function convention() {
  for (const path of [
    join(process.cwd(), 'hud-convention.md'),
    join(hudHome, 'hud-convention.md'),
    fileURLToPath(new URL('../../../../hud-convention.md', import.meta.url)),
  ]) {
    const file = slice(path, 80000);
    if (file) return { path, text: file.text.slice(0, 20000), truncated: file.truncated || file.text.length > 20000 };
  }
  throw new Error('convention_not_found');
}
const piSwitches = ['lens', 'mcp', 'tps', 'ui_ext', 'skills', 'split'] as const;
type PiOptions = Partial<Record<(typeof piSwitches)[number], boolean>> & { pi_args?: string[] };
interface Job extends PiOptions {
  job: string;
  role: string;
  request_key: string;
  cwd: string;
  herdr_pane: string;
  created_at: string;
  package?: string;
  model?: string | null;
  thinking?: string | null;
  model_source?: string | null;
  read_at?: string;
  reaped_at?: string;
  jev?: Role;
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
  tool('hud_roster', 'List local roles, their availability, and the dispatch convention in effect.', {}),
  tool(
    'hud_create',
    'Dispatch a local role; request_key returns the existing job unchanged on retry. Optional package is a display-only label. Launch options are pi-only; omitted switches keep pi-role defaults (split uses the role file).',
    {
      role: text,
      request_key: text,
      task: text,
      cwd: text,
      package: { ...text, description: 'Display-only package label.' },
      model: { ...text, description: 'Override the pi role model for this job only.' },
      thinking: { ...text, description: 'Override the pi role thinking for this job only.' },
      lens: { type: 'boolean', description: 'Load pi-lens (--lens / --no-lens).' },
      mcp: { type: 'boolean', description: 'Load MCP adapter (--mcp / --no-mcp).' },
      tps: { type: 'boolean', description: 'Load tokens/s telemetry (--tps / --no-tps).' },
      ui_ext: {
        type: 'boolean',
        description: 'False: --no-ui-ext; true: keep pi-role default UI extensions (no flag).',
      },
      skills: {
        type: 'boolean',
        description: 'True: --skills (personal skills); false: keep pi-role default exclusion (no flag).',
      },
      split: { type: 'boolean', description: 'Reserve a helper pane on the right; primary worker stays left.' },
      pi_args: {
        type: 'array',
        items: { ...text, maxLength: 4096 },
        maxItems: 128,
        description: 'Append pi arguments after -- verbatim, never through a shell.',
      },
    },
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
function save(job: Job, clearRead = false): void {
  const file = join(directory(job.job), 'job.json');
  // A waiting read can stamp the report while dispatch/send is awaiting a CLI.
  const read_at = json<Job>(file)?.read_at;
  if (clearRead) delete job.read_at;
  else if (read_at) job.read_at = read_at;
  const reaped_at = json<Job>(file)?.reaped_at;
  if (reaped_at) job.reaped_at = reaped_at;
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
function run(
  command: string,
  argv: string[],
  cwd?: string
): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(command, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8').on('data', (data: string) => {
      stdout = (stdout + data).slice(-65536);
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
async function workspaceArgs(job: Job): Promise<string[]> {
  const result = await run('herdr', ['pane', 'get', job.herdr_pane]);
  if (result.exit_code !== 0) return [];
  try {
    const workspace = JSON.parse(result.stdout).result.pane.workspace_id;
    return workspace ? ['--workspace', workspace] : [];
  } catch {
    return [];
  } // An unavailable caller lookup keeps herdr's default workspace.
}
function ensureWatcher(): void {
  fs.mkdirSync(jobsRoot, { recursive: true, mode: 0o700 });
  const script = fileURLToPath(new URL('../../../../bin/hud-watch.mjs', import.meta.url));
  try {
    const pid = Number(fs.readFileSync(join(hudHome, 'watch.pid'), 'utf8').trim());
    process.kill(pid, 0);
    if (fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(script)) return;
  } catch {
    /* No live watcher; races may safely start two. */
  }
  const child = spawn(process.execPath, [script], { detached: true, stdio: 'ignore' });
  child.on('error', (error) => console.error(`hud-watch: ${error.message}`));
  fs.writeFileSync(join(hudHome, 'watch.pid'), `${child.pid}\n`, { mode: 0o600 });
  child.unref();
}
const wideChar = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u;
function cut(text: string, max: number): string {
  const chars = [...text],
    wide = (char: string) => (wideChar.test(char) ? 2 : 1);
  let columns = chars.reduce((sum, char) => sum + wide(char), 0);
  if (columns <= max) return text;
  while (chars.length && columns > max - 1) columns -= wide(chars.pop()!);
  return chars.join('').trimEnd() + '…';
}
/**
 * The worker's herdr tab label: `<role> <package or brief title>` in about 28 columns, on one line (it is recorded as
 * TAB_NAME and pi-role-reap compares it with the tab). A short job suffix is added only when another open job's tab
 * already has the same label.
 */
function tabLabel(job: Job): string {
  const lines = (slice(join(directory(job.job), 'brief.md'), 4096)?.text ?? '').split(/\r?\n/);
  const title =
    job.package?.trim() || (lines.find((line) => /^#{1,6}\s/.test(line)) ?? lines.find((line) => line.trim()) ?? '');
  const label = cut(
    `${job.role} ${title.replace(/^#{1,6}\s+/, '')}`.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim(),
    28
  );
  const taken = jobs().flatMap((other) =>
    other.job === job.job || other.reaped_at
      ? []
      : [slice(join(directory(other.job), 'SESSION.txt'), 4096)?.text.match(/^TAB_NAME=(.*)$/m)?.[1]]
  );
  return taken.includes(label) ? `${cut(label, 23)} ${job.job.slice(-4)}` : label;
}
async function dispatchPi(job: Job, role: Role) {
  try {
    const launcher = executable('pi-role');
    if (!launcher) throw new Error('pi-role not found on PATH');
    const dir = directory(job.job),
      output = join(dir, 'report.md');
    const argv = [
      '--args-json',
      role.pi_role!,
      '--task-dir',
      dir,
      '--role-output',
      output,
      '--dispatch-slot',
      'primary',
      '--dispatch-label',
      job.role,
      '--allow-write',
      output,
      '--qa-dir',
      join(dir, 'qa'),
    ];
    if (job.herdr_pane) argv.push('--orchestrator', job.herdr_pane);
    if (role.thinking !== undefined) argv.push('--dispatch-effort-source', 'orchestrator');
    for (const key of ['lens', 'mcp', 'tps'] as const)
      if (job[key] !== undefined) argv.push(`--${job[key] ? '' : 'no-'}${key}`);
    if (job.ui_ext === false) argv.push('--no-ui-ext');
    if (job.skills === true) argv.push('--skills');
    argv.push('--', '--session-dir', join(dir, 'sessions'), '--tui-mode', 'regular');
    for (const key of ['model', 'thinking'] as const) if (role[key] !== undefined) argv.push(`--${key}`, role[key]);
    argv.push(...(job.pi_args ?? []));
    const built = await run(launcher, argv, job.cwd);
    if (built.exit_code !== 0) return built;
    const piArgs: string[] = JSON.parse(built.stdout);
    fs.mkdirSync(join(dir, 'sessions'), { recursive: true });
    fs.mkdirSync(join(dir, 'qa'), { recursive: true });
    const git = await run('git', ['rev-parse', 'HEAD'], job.cwd);
    const base = git.exit_code === 0 ? git.stdout.trim() : 'HEAD';
    const tabName = tabLabel(job),
      name = `${job.job}-primary`;
    const result = await run('herdr', [
      'tab',
      'create',
      ...(await workspaceArgs(job)),
      '--cwd',
      job.cwd,
      '--label',
      tabName,
      '--no-focus',
    ]);
    if (result.exit_code !== 0) return result;
    const { tab, root_pane } = JSON.parse(result.stdout).result;
    const left = root_pane.pane_id;
    if (!tab.tab_id || !left) throw new Error('tab create did not return tab/root pane ids');
    let right = '';
    const record = () => {
      const fields = {
        TASK: job.job,
        TAB: tab.tab_id,
        TAB_NAME: tabName,
        LEFT: left,
        RIGHT: right,
        ORCH: job.herdr_pane,
        BASE: base,
        PRIMARY: name,
      };
      if (Object.values(fields).some((value) => /[\r\n]/.test(value))) throw new Error('newlines in SESSION values');
      fs.writeFileSync(
        join(dir, 'SESSION.txt'),
        Object.entries(fields)
          .map(([k, v]) => `${k}=${v}\n`)
          .join(''),
        { mode: 0o600 }
      );
    };
    record();
    if (job.split) {
      const split = await run('herdr', [
        'pane',
        'split',
        left,
        '--direction',
        'right',
        '--ratio',
        '0.5',
        '--cwd',
        job.cwd,
        '--no-focus',
      ]);
      if (split.exit_code !== 0) return split;
      right = JSON.parse(split.stdout).result.pane.pane_id;
      record();
    }
    const started = await run('herdr', ['agent', 'start', name, '--kind', 'pi', '--pane', left, '--', ...piArgs]);
    if (started.exit_code !== 0) return started;
    const prompt = `Read ${join(dir, 'brief.md')} and do exactly what it asks.`;
    const submitted = await run('herdr', [
      'agent',
      'prompt',
      name,
      prompt,
      '--wait',
      '--until',
      'working',
      '--timeout',
      '30000',
    ]);
    const status = json<{ task_dir?: string; slot?: string; state?: string; output_written?: boolean }>(
      join(dir, 'STATUS.json')
    );
    if (
      submitted.exit_code !== 0 &&
      !(status?.task_dir === dir && status.slot === 'primary' && status.state === 'closed' && status.output_written)
    ) {
      if (!(submitted.stderr + submitted.stdout).includes('agent_prompt_stalled')) return submitted;
      return run(process.execPath, [join(dirname(launcher), 'prompt-stall.mjs'), dir, name, left, prompt, '120000']);
    }
    return { ...submitted, exit_code: 0 };
  } catch (error) {
    return { exit_code: 1, stdout: '', stderr: String(error) };
  }
}
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
async function dispatchJev(job: Job) {
  const dir = directory(job.job),
    tabName = tabLabel(job);
  const result = await run('herdr', [
    'tab',
    'create',
    ...(await workspaceArgs(job)),
    '--cwd',
    job.cwd,
    '--label',
    tabName,
    '--no-focus',
  ]);
  if (result.exit_code !== 0) return result;
  let created;
  try {
    created = JSON.parse(result.stdout).result;
  } catch (error) {
    return { ...result, exit_code: 1, stderr: `herdr tab create: ${String(error)}` };
  }
  const { tab, root_pane } = created;
  fs.writeFileSync(
    join(dir, 'SESSION.txt'),
    `TASK=${job.job}\nTAB=${tab.tab_id}\nTAB_NAME=${tabName}\nLEFT=${root_pane.pane_id}\nORCH=${job.herdr_pane}\n`,
    { mode: 0o600 }
  );
  const script = fileURLToPath(new URL('../../../../bin/hud-jev.mjs', import.meta.url));
  return run('herdr', ['pane', 'run', root_pane.pane_id, [process.execPath, script, dir].map(quote).join(' ')]);
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
    model: job.model,
    thinking: job.thinking,
    model_source: job.model_source,
    ...Object.fromEntries([...piSwitches, 'pi_args' as const].map((key) => [key, job[key]])),
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
      roles: [...roles().values()].map(assignment),
      convention: convention(),
    };
  if (name === 'hud_create') {
    const role = required(args, 'role');
    let definition = roles().get(role);
    if (!definition) return { ok: false, code: 'role_unavailable' };
    const request_key = required(args, 'request_key');
    const existing = jobs().find((job) => job.request_key === request_key);
    if (existing) {
      ensureWatcher();
      return created(existing);
    }
    if (!process.env.HERDR_PANE_ID) return { ok: false, code: 'herdr_required' };
    const task = required(args, 'task');
    if (args.package !== undefined && typeof args.package !== 'string') throw new Error('invalid_arguments: package');
    for (const key of ['model', 'thinking'] as const) {
      if (args[key] === undefined) continue;
      if (definition.harness !== 'pi') return { ok: false, code: 'invalid_arguments' };
      definition = { ...definition, [key]: required(args, key) };
    }
    const options: PiOptions = definition.harness === 'pi' ? { split: definition.split ?? false, pi_args: [] } : {};
    for (const key of piSwitches) {
      const value = args[key];
      if (value === undefined) continue;
      if (definition.harness !== 'pi' || typeof value !== 'boolean') return { ok: false, code: 'invalid_arguments' };
      options[key] = value;
    }
    if (args.pi_args !== undefined) {
      if (
        definition.harness !== 'pi' ||
        !Array.isArray(args.pi_args) ||
        args.pi_args.length > 128 ||
        args.pi_args.some((value) => typeof value !== 'string' || value.length > 4096)
      )
        return { ok: false, code: 'invalid_arguments' };
      options.pi_args = args.pi_args;
    }
    const effective = definition.harness === 'pi' ? assignment(definition) : null;
    const cwd = resolve(args.cwd === undefined ? process.cwd() : required(args, 'cwd'));
    const job: Job = {
      job: 'j' + randomBytes(8).toString('hex'),
      role,
      request_key,
      cwd,
      herdr_pane: process.env.HERDR_PANE_ID,
      created_at: new Date().toISOString(),
      ...options,
      ...(args.package === undefined ? {} : { package: args.package as string }),
      ...(definition.harness === 'jev' ? { jev: definition } : {}),
      ...(effective
        ? {
            model: effective.model,
            thinking: effective.thinking,
            model_source: args.model !== undefined ? 'hud_create' : effective.model_source,
          }
        : {}),
      dispatch_exit_code: null,
      stderr_tail: '',
      message_keys: [],
    };
    const dir = directory(job.job);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Pi writes the report itself; the Jev CLI saves the browser's answer locally.
    const brief =
      definition.harness === 'jev'
        ? `${task}\n`
        : `${task}\n\nWrite your final answer to ${join(dir, 'report.md')}; the job fails without that file.\n`;
    fs.writeFileSync(join(dir, 'brief.md'), brief, { flag: 'wx', mode: 0o600 });
    // Persist before dispatch: an interrupted launch must not dispatch again on retry.
    save(job);
    ensureWatcher();
    let result;
    try {
      if (definition.harness === 'jev') result = await dispatchJev(job);
      else result = await dispatchPi(job, definition);
    } catch (error) {
      result = { exit_code: 1, stdout: '', stderr: String(error) };
    }
    job.dispatch_exit_code = result.exit_code;
    job.stderr_tail = result.stderr;
    const statusFile = join(dir, 'STATUS.json');
    if (result.exit_code !== 0 && !fs.existsSync(statusFile)) {
      fs.writeFileSync(
        `${statusFile}.${process.pid}.tmp`,
        JSON.stringify({
          state: 'failed',
          harness: definition.harness,
          ...(definition.harness === 'jev'
            ? { provider: definition.provider === 'chatgpt' ? 'openai' : 'gemini' }
            : {}),
          exit_reason: (
            result.stderr.trim() ||
            result.stdout.trim().split(/\r?\n/, 1)[0] ||
            `launch exited ${result.exit_code}`
          ).slice(0, 500),
          ended_at: new Date().toISOString(),
        }) + '\n',
        { mode: 0o600 }
      );
      fs.renameSync(`${statusFile}.${process.pid}.tmp`, statusFile);
    }
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
        ['idle_grace', 'closed', 'failed', 'stopped'].includes(result.state ?? '') ||
        result.questions.length ||
        Date.now() >= end
      ) {
        if (result.report_exists && ['idle_grace', 'closed', 'failed', 'stopped'].includes(result.state ?? '')) {
          const latest = json<Job>(join(dir, 'job.json'))!;
          if (!latest.read_at) {
            latest.read_at = new Date().toISOString();
            save(latest);
          }
        }
        return result;
      }
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
    if (job.jev || !roles().get(job.role)?.can_continue || observation(job).state !== 'idle_grace' || !agent)
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
    save(job, result.exit_code === 0);
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
        instructions: 'Call hud_roster before dispatching.',
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
