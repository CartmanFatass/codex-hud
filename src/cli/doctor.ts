import { createHash } from 'node:crypto';
import { accessSync, constants, lstatSync, readdirSync, readlinkSync, realpathSync, statSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import * as TOML from '@iarna/toml';
import { jobRow, leaseActive, readJobProgress, readLease } from '../collectors/thin-jobs.js';
import { parseWorktreeList } from '../collectors/worktrees.js';
import type { DoneReceipt, Job, JobStatus, Turn } from '../mcp/job-contracts.js';
import { jobFiles as files, REPO_ROOT } from '../mcp/paths.js';
import { receiptForTurn, turnToken } from '../roles/cli-turn.js';
import { isRecord, listedPanes, runCommand } from '../roles/herdr-run.js';
import { JobIndexCache, JOB_ID_RE } from '../roles/job-index-cache.js';
import { readCheckReceipt, sameChecks } from '../roles/job-checks.js';
import { readFileBounded, readJsonBounded } from '../utils/atomic-fs.js';
import { SAFE_GIT_ARGS, safeGitEnv } from '../utils/git-safety.js';
import { isActiveProcState, isValidPid, listProcPids, readProcCmdline, readProcStat, readProcUid } from '../utils/proc.js';
import type { HudIO } from './hud.js';
import { CliError, privateHome } from './private-home.js';

const usage = 'Usage: hud doctor <jobId>';
const limit = 64 * 1024;
type Unavailable = 'missing' | 'unreadable';
const unavailable = (error: unknown): Unavailable =>
  (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
function observe<T>(read: () => T): T | Unavailable {
  try { return read(); } catch (error) { return unavailable(error); }
}
function objectFile<T extends object>(file: string, max = limit, valid?: (value: T) => boolean) {
  return observe(() => {
    const value = readJsonBounded(file, max) as T;
    if (!value || typeof value !== 'object' || Array.isArray(value) || (valid && !valid(value))) throw new Error();
    return value;
  });
}
const presence = (file: string) => observe(() => { lstatSync(file); return 'present' as const; });
const validTurn = (t: Turn) => Number.isSafeInteger(t.seq) && t.seq > 0 && typeof t.sent_at === 'string' &&
  Number.isFinite(Date.parse(t.sent_at)) && (t.report_sig === null || typeof t.report_sig === 'string');

function processFact(pid: unknown, start?: unknown, pidOnly = false) {
  if (!isValidPid(pid)) return { pid: null, liveness: 'unknown' };
  const liveness = observe(() => {
    const proc = readProcStat(pid, { strict: true });
    if (!proc || !isActiveProcState(proc.state)) return 'not alive';
    if (typeof start === 'string' && start) return proc.start === start ? 'alive' : 'start time differs';
    return pidOnly ? 'alive (PID only)' : 'unknown (no start time)';
  });
  return { pid, liveness };
}

/** Read one job only. No store calls: MCP readRow can record failure exhaustion. */
export function collectDoctor(dir: string) {
  const path = (file: string) => join(dir, file);
  const jobFile = objectFile<Partial<Job>>(path(files.job));
  const statusFile = objectFile<Partial<JobStatus>>(path(files.status));
  const j = typeof jobFile === 'object' ? jobFile : {};
  const s = typeof statusFile === 'object' ? statusFile : null;
  const browser = j.bro || j.jev || s?.harness === 'bro' || j.place?.harness === 'bro';
  const cli = !browser && (s?.harness === 'cli' || !!j.cli || j.place?.harness === 'cli');
  const shared = observe(() => {
    const cache = new JobIndexCache(dirname(dirname(dir)));
    const { display_state, state, reason, blocked, report_unread, question_ids } = jobRow(j, s, { dir, cache });
    return { display_state, state, reason, blocked, report_unread, question_ids };
  });
  const report = observe(() => {
    // Same signature as reportSignature, from one opened inode and with a hard byte cap.
    const { bytes, stat, truncated } = readFileBounded(path(files.report), limit);
    if (truncated) throw new Error();
    return { report_sig: bytes.toString('utf8').trim()
      ? `${stat.mtimeMs}:${bytes.length}:${createHash('sha256').update(bytes).digest('hex')}` : null };
  });
  const turn = cli ? objectFile<Turn>(path(files.turn), limit, validTurn) : 'n/a';
  const done = cli ? objectFile<DoneReceipt>(path(files.done), 1024, (d) => validTurn(d) &&
    typeof d.report_sig === 'string' && typeof d.at === 'string') : 'n/a';
  const sig = typeof report === 'object' ? report.report_sig : null;
  const current = typeof turn === 'object' && typeof done === 'object' ? receiptForTurn(turn, done) : 'unknown';
  const changed = sig && typeof turn === 'object' ? sig !== turn.report_sig : 'unknown';
  const matches = sig && typeof done === 'object' ? done.report_sig === sig : 'unknown';
  const notes: string[] = [];
  if (typeof turn === 'object' && typeof done === 'object' && !current) {
    notes.push(done.seq !== turn.seq ? `done.json seq ${done.seq} differs from turn.json seq ${turn.seq}.`
      : done.sent_at !== turn.sent_at ? 'done.json sent_at differs from turn.json sent_at.'
        : done.report_sig === turn.report_sig ? 'done.json report_sig equals the turn.json baseline report_sig.'
          : 'done.json at is not a valid timestamp.');
  }
  if (matches === false) notes.push('done.json report_sig differs from the current report.md signature; the receipt does not match.');
  if (changed === false) notes.push('report.md signature equals turn.json report_sig; no new report signature for this turn.');
  const questions = typeof shared === 'object' ? shared.question_ids : shared;
  if (Array.isArray(questions) && questions.length) notes.push(`qa has no matching .answer.md for: ${questions.join(', ')}.`);

  const facts = {
    job: basename(dir),
    identity: typeof jobFile === 'string' ? jobFile : {
      role: j.role, harness: s?.harness ?? j.place?.harness ?? (cli ? 'cli' : browser ? 'bro' : 'pi'),
      agent: s?.agent ?? j.cli?.agent, headless: j.headless, place: j.place, model: s?.model ?? j.model,
      project: j.project_root ?? j.cwd, worktree: j.worktree, attempts: j.attempts, used_place: j.used_place,
    },
    shared, report: cli && typeof report === 'object' ? { ...report, changed_since_turn: changed } : report,
    turn: typeof turn === 'object' ? { seq: turn.seq, sent_at: turn.sent_at, report_sig: turn.report_sig } : turn,
    receipt: typeof done === 'object' ? { seq: done.seq, sent_at: done.sent_at, report_sig: done.report_sig, at: done.at,
      for_current_turn: current, matches_report_on_disk: matches } : done,
    questions, status: statusFile,
  };
  if (browser) return { ...facts, notes };

  const checkFile = presence(path(files.checks));
  const check = checkFile === 'present' ? readCheckReceipt(dir) : null;
  // Compare the check binding against the bounded reads above; jobChecks re-reads the turn and report without a cap.
  const token = cli ? (typeof turn === 'object' ? turnToken(turn) : null) : j.pi_sent_at ?? j.created_at;
  const bound = check && token && sig ? sameChecks(check, { turn: token, report_sig: sig }) : 'unknown';
  if (bound === false) notes.push('checks.json turn or report_sig differs from the current turn or report.md signature.');
  const supervisor = observe(() => {
    const { bytes, truncated } = readFileBounded(path(files.supervisorPid), 256);
    const pid = Number(bytes.toString('utf8').trim());
    if (truncated || !isValidPid(pid)) throw new Error();
    return pid;
  });
  const progress = readJobProgress(dir).latest_progress;
  return { ...facts,
    checks: {
      defined: Array.isArray(j.checks) ? j.checks.length : typeof jobFile === 'string' ? 'unknown' : 0,
      receipt: check ? { turn: check.turn, report_sig: check.report_sig, state: check.state, bound_to_current_report: bound,
        results: check.results.map((result) => ({ command: result?.command, exit_code: result?.exit_code })) }
        : checkFile === 'present' ? 'unreadable' : checkFile,
    },
    progress: progress ?? (presence(path(files.progress)) === 'missing' ? 'missing' : 'unreadable'),
    markers: { stop_requested: presence(path(files.stopRequested)), close_requested: presence(path(files.closeRequested)) },
    processes: { supervisor_pid_file: supervisor, supervisor: processFact(typeof supervisor === 'number' ? supervisor : s?.supervisor_pid, null, true),
      worker: processFact(s?.pid, s?.pid_start_time) },
    notes,
  };
}

export type DoctorReport = ReturnType<typeof collectDoctor>;
export function formatDoctor(report: DoctorReport): string {
  const { notes, ...sections } = report;
  // JSON keeps control bytes in job-provided text out of the terminal, including C1 and bidi controls.
  const json = (value: unknown, indent?: number) => JSON.stringify(value, null, indent)
    .replace(/[\u007f-\u009f\p{Bidi_Control}\u2028\u2029]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return Object.entries(sections).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : json(value, key === 'status' ? 2 : undefined)}\n`).join('') +
    `notes:\n${notes.length ? notes.map((note) => `  - ${note}\n`).join('') : '  none\n'}`;
}

type Check = { name: string; detail: string; fix?: string };
const check = (name: string, detail: string, fix?: string): Check => ({ name, detail, fix });
const record = (value: unknown) => isRecord(value) ? value : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const quoted = (value: string) => JSON.stringify(value).replace(/[\u007f-\u009f\p{Bidi_Control}\u2028\u2029]/gu,
  (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const listing = (values: string[]) => values.slice(0, 6).map(quoted).join(', ') +
  (values.length > 6 ? ` (+${values.length - 6} more)` : '');
const config = (file: string) => objectFile<Record<string, unknown>>(file, 2 * 1024 * 1024);

function clientReader(home: string) {
  const credentials = observe(() => statSync(join(home, 'credentials.env')));
  const validate = (st: Stats) => {
    if (typeof credentials === 'object' && st.ino === credentials.ino && st.dev === credentials.dev) throw Error();
  };
  return (file: string, parse: (text: string) => unknown) => observe(() => {
    // Client settings are often dotfile symlinks. Never open a credential alias.
    const target = realpathSync(file);
    if (basename(target) === 'credentials.env') throw Error();
    validate(statSync(target));
    const { bytes, truncated } = readFileBounded(target, 2 * 1024 * 1024, { validate });
    if (truncated) throw Error();
    const value = parse(bytes.toString('utf8'));
    if (!isRecord(value)) throw Error();
    return value;
  });
}
const mcpEntry = 'packages/hud-mcp/bin/hud-mcp.mjs';
const watchEntry = 'packages/hud-mcp/bin/hud-watch.mjs';
const nodeName = (name: string) => /^node(?:js|[-.]?\d[\d.]*)?$/.test(basename(name));

function executable(command: unknown, env: NodeJS.ProcessEnv): string | null {
  if (typeof command !== 'string' || !command) return null;
  const candidates = isAbsolute(command) ? [command] : /^[\w.-]+$/.test(command)
    ? (env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => resolve(dir, command)) : [];
  for (const file of candidates) {
    const found = observe(() => {
      const target = realpathSync(file);
      if (!statSync(target).isFile()) return null;
      accessSync(target, constants.X_OK);
      return target;
    });
    if (found && found !== 'missing' && found !== 'unreadable') return found;
  }
  return null;
}
const checkout = (path: string | null, entry: string) =>
  path?.endsWith('/' + entry) ? path.slice(0, -entry.length - 1) || '/' : null;
const regular = (file: string) => observe(() => statSync(file).isFile()) === true;
const directory = (file: string) => observe(() => statSync(file).isDirectory()) === true;
const names = (dir: string) => observe(() => readdirSync(dir));

function installedDeps(root: string): Check {
  const name = 'package-lock / node_modules', fix = 'Run npm ci in the installed checkout.';
  const lock = record(config(join(root, 'package-lock.json'))), packages = record(lock.packages);
  const keys = Object.keys(packages).filter((key) => key !== '');
  const packagePath = /^(?:node_modules\/(?:@[\w.-]+\/)?[\w.-]+\/)*node_modules\/(?:@[\w.-]+\/)?[\w.-]+$/;
  if (!isRecord(packages['']) || keys.length > 512 || keys.some((key) => !packagePath.test(key) ||
      key.split('/').some((part) => part === '.' || part === '..'))) return check(name, 'lockfile missing, invalid or over limit', fix);
  const bad = keys.filter((key) => {
    const want = record(packages[key]), got = config(join(root, key, 'package.json'));
    return !(want.optional === true && got === 'missing') &&
      (typeof want.version !== 'string' || record(got).version !== want.version);
  });
  return bad.length ? check(name, `missing or mismatched: ${listing(bad)}`, fix) : check(name, `${keys.length} locked package versions match`);
}

function bindingChecks(root: string, home: string, env: NodeJS.ProcessEnv) {
  const userHome = env.HOME || homedir(), node = executable('node', env), roots = new Set([root]);
  const read = clientReader(home), json = (path: string) => read(path, JSON.parse);
  const claudePath = join(env.CLAUDE_CONFIG_DIR || userHome, '.claude.json');
  const claude = json(claudePath);
  const claudeSettings = json(join(env.CLAUDE_CONFIG_DIR || join(userHome, '.claude'), 'settings.json'));
  const codex = read(join(env.CODEX_HOME || join(userHome, '.codex'), 'config.toml'), TOML.parse);
  const gemini = join(userHome, '.gemini'), agyPath = join(gemini, 'antigravity-cli/settings.json');
  const agy = json(agyPath), agyMcp = json(join(gemini, 'config/mcp_config.json'));
  const grokPath = join(userHome, '.grok/trusted_folders.toml');
  const grok = read(grokPath, TOML.parse);
  const agents = {
    claude: !!executable('claude', env) || claude !== 'missing' || claudeSettings !== 'missing',
    codex: !!executable('codex', env) || codex !== 'missing',
    agy: !!executable('agy', env) || agy !== 'missing' || agyMcp !== 'missing',
    grok: !!executable('grok', env) || grok !== 'missing',
  };
  const fix = (client: string) => `Run ./install --with ${client} from the intended checkout.`;
  const binding = (name: string, client: string, target: string | null, runtime: string | null) => {
    if (target) roots.add(target);
    const detail = `checkout ${target ? quoted(target) : 'unresolved'}; Node ${runtime ? quoted(runtime) : 'unresolved'}`;
    return check(name, detail + (target && target !== root ? ' (different checkout)' : ''),
      target === root && runtime && regular(join(target, 'dist/index.js')) ? undefined : fix(client));
  };
  function mcp(name: string, client: string, value: unknown) {
    const row = record(value);
    if (row.enabled === false || row.disabled === true) return check(name, 'HUD binding is disabled', fix(client));
    const surface = record(row.env).HUD_MCP_SURFACE;
    if (surface !== undefined && surface !== 'roles') return check(name, 'invalid HUD MCP surface', fix(client));
    const command = executable(row.command, env), args = list(row.args);
    const explicitNode = command && nodeName(command);
    return binding(name, client, checkout(explicitNode ? executable(args[0], env) : command, mcpEntry), explicitNode ? command : node);
  }
  function statusline(name: string, client: string, value: unknown) {
    const row = record(value);
    if (typeof row.command === 'string' && !row.command.endsWith('hud-statusline')) return check(name, 'owner statusline (not replaced by HUD)');
    return binding(name, client, checkout(executable(row.command, env), 'bin/hud-statusline'), node);
  }
  const results = [
    ...(agents.claude ? [mcp('Claude MCP', 'claude', record(record(claude).mcpServers).hud),
      statusline('Claude statusline', 'claude', record(claudeSettings).statusLine)] : [check('Claude binding', 'client not installed')]),
    agents.codex ? mcp('Codex MCP', 'codex', record(record(codex).mcp_servers).hud) : check('Codex binding', 'client not installed'),
    ...(agents.agy ? [mcp('Antigravity MCP', 'agy', record(record(agyMcp).mcpServers).hud),
      statusline('Antigravity statusline', 'agy', record(agy).statusLine)] : [check('Antigravity binding', 'client not installed')]),
  ];
  if (agents.agy) {
    const hook = join(home, 'integrations/agy/pre-invocation.sh');
    const hooks = json(join(gemini, 'config/hooks.json'));
    const configured = list(record(record(hooks).hud).PreInvocation).some((entry) =>
      record(entry).command === `'${hook.replaceAll("'", "'\\''")}'`);
    const allowed = list(record(record(agy).permissions).allow).includes('mcp(hud/*)');
    results.push(configured && executable(hook, env) === join(root, 'integrations/agy/pre-invocation.sh') && allowed
      ? check('Antigravity hook / permission', 'hook and permission registered')
      : check('Antigravity hook / permission', 'HUD hook or MCP permission missing or invalid', fix('agy')));
  }
  const marketplace = record(record(record(claudeSettings).extraKnownMarketplaces)['myhud-local']).source;
  const plugin = record(record(claudeSettings).enabledPlugins)['hud-mod@myhud-local'];
  if (marketplace !== undefined || plugin !== undefined) {
    const source = record(marketplace).path;
    const target = typeof source === 'string' && isAbsolute(source) ? observe(() => realpathSync(source)) : null;
    results.push(plugin === true && target === root && node ? check('Claude mod binding', `checkout ${quoted(root)}; Node ${quoted(node)}`)
      : check('Claude mod binding', 'HUD marketplace, plugin or Node is not bound to this install', fix('claude-mod')));
  }
  const piDir = env.PI_CODING_AGENT_DIR || join(userHome, '.pi/agent');
  const pi = record(json(join(piDir, 'settings.json')));
  for (const [dir, ext, name] of [['pi-package', 'hud.mjs', 'pi roles'], ['pi-display', 'hud-display.mjs', 'pi display']]) {
    const pkg = join(home, dir), pin = record(config(join(pkg, 'binding.json')));
    const registered = list(pi.packages).some((item) => {
      const source = typeof item === 'string' ? item : record(item).source;
      return typeof source === 'string' &&
        (source.startsWith('~/') ? join(userHome, source.slice(2)) : resolve(piDir, source)) === pkg;
    });
    const { release } = pin;
    const resolved = typeof release === 'string' && isAbsolute(release) ? observe(() => realpathSync(release)) : null;
    const target = resolved !== 'missing' && resolved !== 'unreadable' ? resolved : null;
    const result = binding(name, 'pi', target,
      typeof pin.node === 'string' && isAbsolute(pin.node) ? executable(pin.node, env) : null);
    if (!registered || pin.hudHome !== home || !regular(join(pkg, 'extensions', ext)) || !regular(join(pkg, 'package.json')) ||
        !target || !regular(join(target, 'dist/harness/pi/package-entry.js')) || !regular(join(target, mcpEntry))) {
      result.detail += '; package registration or binding incomplete';
      result.fix = fix('pi');
    }
    results.push(result);
  }
  // HUD's dispatch trust reader rejects symlinked trust files even if the client reads them.
  const trust = (path: string, data: unknown) => observe(() => lstatSync(path).isFile()) === true ? record(data) : {};
  return { results, roots, agents, claude: trust(claudePath, claude), agy: trust(agyPath, agy), grok: trust(grokPath, grok) };
}

function registry(home: string): string[] | Unavailable {
  const data = config(join(home, 'projects.json'));
  if (data === 'missing') return [];
  if (typeof data !== 'object' || data.version !== 1 || !Array.isArray(data.projects) ||
      !data.projects.every((item) => typeof item?.root === 'string' && isAbsolute(item.root))) return 'unreadable';
  return [...new Set<string>(data.projects.map((item) => item.root))];
}

function projectTrust(projects: string[] | Unavailable, bindings: ReturnType<typeof bindingChecks>): Check {
  const name = 'project CLI trust';
  if (!Array.isArray(projects) || projects.length > 16) return check(name, 'project registry unavailable or over limit', 'Review HUD_HOME/projects.json.');
  const absent: string[] = [];
  const { agents, claude, agy, grok } = bindings;
  for (const project of projects) {
    const root = observe(() => realpathSync(project));
    if (root === 'missing' || root === 'unreadable' || !directory(root)) { absent.push(`${project}: checkout unavailable`); continue; }
    const missing = [
      agents.claude && record(record(record(claude).projects)[root]).hasTrustDialogAccepted !== true && 'claude',
      agents.agy && !list(record(agy).trustedWorkspaces).includes(root) && 'agy',
      agents.grok && record(record(record(grok).folders)[root]).trusted !== true && 'grok',
    ].filter(Boolean);
    if (missing.length) absent.push(`${project}: ${missing.join(', ')}`);
  }
  return absent.length ? check(name, listing(absent), 'For each available checkout, run hud trust <dir>.')
    : check(name, `${projects.length} registered checkout(s); installed CLI trust checked (Codex bypasses trust)`);
}

function credentialsMode(home: string): Check {
  const name = 'credentials.env mode', file = join(home, 'credentials.env');
  // Do not open the file, including symlinks, for any reason.
  const meta = observe(() => lstatSync(file));
  if (meta === 'missing') return check(name, 'absent (optional)');
  if (typeof meta === 'object' && meta.isFile() && (meta.mode & 0o7777) === 0o600) return check(name, '0600 (metadata only)');
  return check(name, typeof meta === 'object' && meta.isFile() ? `0${(meta.mode & 0o7777).toString(8)} (expected 0600)` : 'not a readable regular-file entry',
    'Use a regular credentials.env file with chmod 600.');
}

function stuckLeases(home: string): Check {
  const name = 'stuck leases', entries = names(join(home, 'leases'));
  const leases = Array.isArray(entries) ? entries.filter((file) => /^[a-f0-9]{64}\.json$/.test(file)) : [];
  if (entries === 'unreadable' || leases.length > 512) return check(name, 'lease inventory unavailable or over limit', 'Review HUD_HOME/leases.');
  const stale: string[] = [], unknown: string[] = [];
  for (const file of leases) {
    const lease = readLease(join(home, 'leases', file));
    if (!lease) unknown.push(file);
    else if (!leaseActive(home, lease)) stale.push(file);
  }
  return stale.length || unknown.length ? check(name, `${stale.length} inactive, ${unknown.length} unreadable: ${listing([...stale, ...unknown])}`,
    'Review the lease holders before clearing stale records.')
    : check(name, `${leases.length} active, none stuck`);
}

async function orphanWorktrees(home: string, projects: string[] | Unavailable, env: NodeJS.ProcessEnv): Promise<Check> {
  const name = 'orphaned worktrees', fix = 'Review git worktree list and the job receipts before removing any worktree.';
  if (!Array.isArray(projects) || projects.length > 16) return check(name, 'project registry unavailable or over limit', fix);
  const results = await Promise.all(projects.map(async (project) => {
    const git = await runCommand('git', ['-C', project, ...SAFE_GIT_ARGS, 'worktree', 'list', '--porcelain', '-z'], safeGitEnv(env), { budgetMs: 150 });
    if (!git.ok) return null;
    try {
      const [main, ...linked] = parseWorktreeList(git.stdout);
      if (!main) return null;
      const parent = join(dirname(main.path), `${basename(main.path)}-wt`);
      return linked.filter((tree) => dirname(tree.path) === parent && /^[a-z0-9-]+-[0-9a-f]{6}$/.test(basename(tree.path)) &&
        tree.branch === `wt/${basename(tree.path)}`).map((tree) => tree.path);
    } catch { return null; }
  }));
  if (results.some((result) => result === null)) return check(name, 'could not verify every registered checkout', fix);
  const trees = [...new Set(results.flatMap((result) => result ?? []))];
  if (!trees.length) return check(name, 'no managed worktrees in registered checkouts');
  const jobs = names(join(home, 'jobs'));
  if (jobs === 'unreadable' || trees.length > 256) return check(name, 'inventory unreadable or over limit', fix);
  const suffixes = new Set(trees.map((path) => path.slice(-6))), owned = new Set<string>();
  let unreadable = 0;
  const candidates = Array.isArray(jobs) ? jobs.filter((id) => JOB_ID_RE.test(id) && suffixes.has(id.slice(-6))) : [];
  if (candidates.length > 512) return check(name, 'job receipt inventory over limit', fix);
  for (const id of candidates) {
    const receipt = objectFile<Partial<Job>>(join(home, 'jobs', id, files.job));
    if (typeof receipt === 'object' && typeof receipt.worktree?.root === 'string') owned.add(receipt.worktree.root);
    else if (receipt === 'unreadable') unreadable++;
  }
  const orphans = trees.filter((tree) => !owned.has(tree));
  return orphans.length || unreadable ? check(name,
    `${orphans.length} without a readable owning job receipt${orphans.length ? ': ' + listing(orphans) : ''}`, fix)
    : check(name, `${trees.length} managed worktree(s) have owners`);
}

function diskStamp(root: string) {
  return observe(() => {
    const st = statSync(join(root, 'dist/index.js'), { bigint: true });
    if (!st.isFile()) throw Error();
    return { stamp: `${st.ino}:${st.ctimeNs}`, time: st.mtime.toISOString() };
  });
}

function generationChecks(home: string, roots: ReadonlySet<string>): Check[] {
  const watcher = observe(() => {
    const { bytes, truncated } = readFileBounded(join(home, 'watch.pid'), 32);
    const pid = Number(bytes.toString().trim());
    if (truncated || !isValidPid(pid)) throw Error();
    return pid;
  });
  const pids = observe(listProcPids);
  const fixes = { mcp: 'Reconnect the client to reload its HUD MCP server.', watcher: 'Let the watcher reload, or restart it when jobs are safe.' };
  const found = { mcp: [] as string[], watcher: [] as string[] }, bad = { mcp: false, watcher: false };
  for (const pid of Array.isArray(pids) ? pids.slice(0, 4096) : []) {
    if (readProcUid(pid) !== process.getuid?.() || !nodeName(observe(() => readlinkSync(`/proc/${pid}/exe`)))) continue;
    const kind = pid === watcher ? 'watcher' : 'mcp';
    const args = readProcCmdline(pid);
    if (!args?.length) continue;
    const entry = kind === 'mcp' ? mcpEntry : watchEntry;
    const arg = args.slice(1).find((part) => kind === 'mcp' ? /^hud-mcp(?:\.mjs)?$/.test(basename(part)) : basename(part) === 'hud-watch.mjs');
    if (!arg) continue;
    const root = observe(() => checkout(realpathSync(isAbsolute(arg) ? arg : join(`/proc/${pid}/cwd`, arg)), entry));
    if (!root || root === 'missing' || root === 'unreadable' || (kind === 'mcp' && !roots.has(root))) continue;
    const proc = readProcStat(pid), disk = diskStamp(root);
    if (!proc || !isActiveProcState(proc.state)) continue;
    const receipt = objectFile<{ kind: unknown; stamp: unknown; start: unknown }>(join(home, 'generations', `${pid}.json`), 1024);
    const known = typeof receipt === 'object' && receipt.start === proc.start && receipt.kind === kind && typeof receipt.stamp === 'string';
    const state = !known ? 'generation unreported' : typeof disk !== 'object' ? 'dist unavailable' :
      receipt.stamp !== disk.stamp ? 'stale generation' : 'current';
    found[kind].push(`${pid}: ${state}`);
    if (state !== 'current') bad[kind] = true;
  }
  return (['mcp', 'watcher'] as const).map((kind) => {
    const name = kind === 'mcp' ? 'MCP generation' : 'watcher generation';
    if (!Array.isArray(pids) || pids.length > 4096) return check(name, 'process inventory unavailable or over limit', fixes[kind]);
    if (kind === 'watcher' && watcher !== 'missing' && !found.watcher.length) return check(name, 'watch.pid does not identify a running watcher', fixes[kind]);
    return check(name, found[kind].join(', ') || 'not running (on demand)', bad[kind] ? fixes[kind] : undefined);
  });
}

async function installDoctor(io: HudIO): Promise<number> {
  const { env } = io, fallback = resolve(REPO_ROOT), installed = checkout(executable('hud', env), 'bin/hud');
  const root = installed ?? fallback, stamp = diskStamp(root);
  const herdr = executable('herdr', env);
  const reachability = herdr ? runCommand('herdr', ['pane', 'list'], env, { budgetMs: 120 }) : null;
  const checks = [check('Node', `${process.version} at ${quoted(process.execPath)}`,
    Number(process.versions.node.split('.')[0]) >= 24 ? undefined : 'Use Node >=24.0.0.')];
  const pi = executable('pi', env);
  const install = [check('HUD on PATH', installed ? quoted(installed) : 'HUD launcher not resolved', installed ? undefined : 'Put the installed hud launcher on PATH.'),
    typeof stamp === 'object' ? check('dist build stamp', `${stamp.stamp} (${stamp.time}) in ${quoted(root)}`)
      : check('dist build stamp', 'dist/index.js unavailable', 'Run npm run build in the installed checkout.'), installedDeps(root)];
  const home = observe(() => privateHome(env));
  let state: Check[];
  if (home === 'missing' || home === 'unreadable') state = [check('HUD_HOME', 'missing or not private', 'Use a private HUD_HOME directory owned by this user.')];
  else {
    const projects = registry(home), trees = orphanWorktrees(home, projects, env);
    const bindings = bindingChecks(root, home, env);
    state = [...generationChecks(home, bindings.roots), ...bindings.results, projectTrust(projects, bindings),
      credentialsMode(home), stuckLeases(home), await trees];
  }
  const reachable = await reachability;
  checks.push(reachable?.ok && listedPanes(reachable.stdout) ? check('herdr', 'reachable') : check('herdr',
    herdr ? 'not reachable within the preflight budget' : 'not on PATH', 'Run hud doctor inside a working herdr session.'),
    check('pi', pi ? quoted(pi) : 'not on PATH', pi ? undefined : 'Install pi and put it on PATH.'), ...install, ...state);
  await io.stdout(checks.map(({ name, detail, fix }) => `${fix ? 'FAIL' : 'PASS'} ${name}: ${detail}${fix ? ` — Fix: ${fix}` : ''}\n`).join(''));
  return checks.some((row) => row.fix) ? 1 : 0;
}

export async function versionCommand(io: HudIO): Promise<number> {
  const info = objectFile<{ version: string; commit: string | null; builtAt: string }>(join(REPO_ROOT, 'dist/build-info.json'), 1024,
    (value) => /^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(value.version) &&
      (value.commit === null || /^[0-9a-f]{40,64}$/.test(value.commit)) && Number.isFinite(Date.parse(value.builtAt)));
  if (typeof info !== 'object') throw new CliError('build_info_unavailable: run npm run build', 1);
  await io.stdout(`hud ${info.version} (commit ${info.commit ?? 'unknown'}, built ${new Date(info.builtAt).toISOString()})\n`);
  return 0;
}

export async function doctorCommand(args: readonly string[], io: HudIO): Promise<number> {
  if (!args.length) return installDoctor(io);
  if (args.length !== 1) throw new CliError(usage);
  const [id] = args;
  if (!JOB_ID_RE.test(id)) throw new CliError(`invalid_job_id: ${usage}`);
  const dir = join(privateHome(io.env), 'jobs', id);
  const found = observe(() => lstatSync(dirname(dir)).isDirectory() && lstatSync(dir).isDirectory());
  if (found !== true) throw new CliError(`${found === 'unreadable' ? 'unreadable_job_directory' : 'job_not_found'}: ${id}`, 1);
  await io.stdout(formatDoctor(collectDoctor(dir)));
  return 0;
}
