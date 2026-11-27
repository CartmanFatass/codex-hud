import { spawnSync } from 'node:child_process';
import { lstatSync, opendirSync, realpathSync, statSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { loadSettings } from '../settings.js';
import { SAFE_GIT_ARGS, safeGitEnv } from '../utils/git-safety.js';
import { dispatchChoice, dispatchDecision } from './dispatch-decision.js';
import { jobFiles } from './paths.js';

export type PermissionDecision = { action: 'approve' | 'main'; reason: string };
export type PermissionRoots = {
  task: string;
  scratch?: string;
  temp?: string;
  worktree?: string;
  /** Verifiable cwd from the prompt or worker process (/proc/<pid>/cwd); never job.cwd. */
  cwd?: string;
};
export type PermissionRootCategory =
  | 'scratchpad'
  | 'task scratchpad'
  | 'temporary directory'
  | 'worktree'
  | 'worktree (Git-tracked files)'
  | 'task directory';
export type PermissionOpKind =
  | 'file_edit'
  | 'file_write'
  | 'file_create'
  | 'housekeeping'
  | 'read_only'
  | 'local_build'
  | 'git_local';
export type PermissionFlag =
  | 'recursive'
  | 'force'
  | 'glob'
  | 'symlink'
  | 'extract'
  | 'redirect_write'
  | 'redirect_read'
  | 'pipe'
  | 'git_tracked_only'
  | 'verified_cwd';
export type PermissionStepProof = {
  kind: PermissionOpKind;
  verb: string;
  roots: PermissionRootCategory[];
  flags: PermissionFlag[];
};
export type PermissionProof = {
  operations: PermissionStepProof[];
  roots: PermissionRootCategory[];
  summary: string;
  fingerprint: string;
};
export type FilePromptTarget = {
  kind: 'file_edit' | 'file_write' | 'file_create';
  paths: string[];
  cwd?: string;
};
export type ShellPromptTarget = {
  kind: 'shell';
  command: string;
  cwd?: string;
};
export type PermissionTarget = FilePromptTarget | ShellPromptTarget;

const MAX_COMMAND_CHARS = 4096;
const MAX_COMMANDS = 16;
const MAX_TOKENS = 128;
const MAX_WALK_ENTRIES = 4096;
const MAX_TRACKED_FILES = 256;

const safePath = /^[A-Za-z0-9_./-]+$/;
const globChars = /[*?[]/;
const inside = (root: string, target: string) => {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
};

const SENSITIVE_EXT = /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|crt|cer|der|asc|gpg|pgp|env|secret|secrets|token|cred|creds)$/i;
const SENSITIVE_NAME = /^(?:secrets?|credentials?|creds?|tokens?|keys?|passwd|passwords?|private[-_]?keys?|api[-_]?keys?|apikeys?|auth[-_]?tokens?|access[-_]?keys?|id_rsa|id_ed25519|id_ecdsa|id_dsa|authorized_keys|known_hosts|netrc|npmrc|pypirc|htpasswd|shadow|master\.key|auth\.json)(?:\.[^/]+)?$/i;
const SENSITIVE_SUFFIX = /[-_](?:secrets?|credentials?|private[-_]?keys?|api[-_]?keys?|passwords?|passwd)(?:\.[^/]+|$)/i;

function isSensitiveRel(rel: string): boolean {
  if (!rel) return false;
  for (const segment of rel.split('/')) {
    if (!segment) continue;
    if (segment.startsWith('.')) return true;
    if (SENSITIVE_EXT.test(segment) || SENSITIVE_NAME.test(segment) || SENSITIVE_SUFFIX.test(segment)) return true;
  }
  return false;
}

const HUD_CONTROL_FILES = new Set<string>(Object.values(jobFiles));
function isHudControlPath(rel: string): boolean {
  const first = rel.split('/')[0];
  return !first || HUD_CONTROL_FILES.has(first) || first.startsWith('STATUS.json.');
}

const FORBIDDEN_ASSIGN_VARS = new Set([
  'PATH', 'IFS', 'BASH_ENV', 'ENV', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'NODE_OPTIONS', 'NODE_PATH',
  'GIT_EXEC_PATH', 'GIT_TEMPLATE_DIR', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'CARGO_HOME', 'RUSTC_WRAPPER', 'HOME', 'TMPDIR',
  'SHELL', 'CDPATH', 'GLOBIGNORE', 'PROMPT_COMMAND', 'ZDOTDIR',
]);
const READ_ONLY_PIPE_SINKS = new Set(['head', 'tail', 'wc', 'grep', 'rg', 'cat', 'diff']);

/** Parse a small regenerable shell form without invoking a shell or expanding general variables. */
export function permissionDirectory(command: string | undefined): string | undefined {
  const match = /^(?:S=([\w./-]+); )?rm -f (\$S|\$\{S\}|[\w./-]+)\/\*\.png$/.exec(command ?? '');
  if (!match || (match[1] && !match[2].startsWith('$'))) return;
  const path = match[2].startsWith('$') ? match[1] : match[2];
  if (!path || !safePath.test(path) || !isAbsolute(path) || path.split('/').includes('..')) return;
  return resolve(path);
}

type VerifiedRoot = { category: PermissionRootCategory; real: string };
type ResolvedRoots = {
  ordered: VerifiedRoot[];
  worktree?: string;
  verifiedCwd?: string;
};

function verifyRootDir(dir: string | undefined): string | undefined {
  if (!dir || !isAbsolute(dir)) return;
  try {
    const real = realpathSync(dir);
    const st = statSync(real);
    const uid = process.getuid?.();
    if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) return;
    return real;
  } catch { return; }
}

function resolveRoots(roots: PermissionRoots): ResolvedRoots {
  const ordered: VerifiedRoot[] = [];
  const seen = new Set<string>();
  const add = (category: PermissionRootCategory, dir: string | undefined) => {
    const real = verifyRootDir(dir);
    if (!real || seen.has(real)) return;
    seen.add(real);
    ordered.push({ category, real });
  };
  const worktree = verifyRootDir(roots.worktree);
  add('scratchpad', roots.scratch);
  if (worktree) add('scratchpad', join(worktree, 'scratchpad'));
  add('task scratchpad', resolve(roots.task, 'scratchpad'));
  add('temporary directory', roots.temp);
  if (worktree) add('worktree', worktree);
  add('task directory', roots.task);
  const cwdReal = verifyRootDir(roots.cwd);
  const verifiedCwd = cwdReal && worktree && inside(worktree, cwdReal) ? cwdReal : undefined;
  return { ordered, worktree, verifiedCwd };
}

type ResolvedTarget = {
  canonical: string;
  category: PermissionRootCategory;
  rootReal: string;
  rel: string;
  exists: boolean;
  isDir: boolean;
  isSymlink: boolean;
  usedCwd: boolean;
};

function resolveTargetPath(
  rawPath: string,
  activeCwd: string | undefined,
  roots: ResolvedRoots,
  opts: { mode: 'read' | 'write' | 'delete'; allowRootItself?: boolean; cwdBase?: string },
): ResolvedTarget | undefined {
  if (!rawPath || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(rawPath)) return;
  if (rawPath === '~' || rawPath.startsWith('~/') || rawPath.startsWith('~') || globChars.test(rawPath)) return;
  if (rawPath.split('/').includes('..')) return;
  const base = opts.cwdBase ?? activeCwd;
  if (!isAbsolute(rawPath) && !base) return;
  const abs = isAbsolute(rawPath) ? resolve(rawPath) : resolve(base!, rawPath);
  const uid = process.getuid?.();

  let existing = abs;
  let st: Stats | undefined;
  while (true) {
    try {
      st = lstatSync(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
      const parent = dirname(existing);
      if (parent === existing) return;
      existing = parent;
    }
  }
  let realExisting: string;
  try {
    realExisting = realpathSync(existing);
    const targetSt = st.isSymbolicLink() ? statSync(realExisting) : st;
    if (uid !== undefined && targetSt.uid !== uid) return;
  } catch {
    return;
  }
  const tail = relative(existing, abs);
  const canonical = tail ? join(realExisting, tail) : realExisting;
  const matched = roots.ordered.find(root => inside(root.real, canonical) && inside(root.real, realExisting));
  if (!matched) return;
  const rel = relative(matched.real, canonical);
  if (!rel && !opts.allowRootItself) return;
  if (rel && isSensitiveRel(rel)) return;
  if (matched.category === 'task directory' && opts.mode !== 'read') {
    if (opts.mode === 'delete') return;
    if (!rel || isHudControlPath(rel)) return;
  }
  return {
    canonical,
    category: matched.category,
    rootReal: matched.real,
    rel,
    exists: existing === abs,
    isDir: existing === abs && !st.isSymbolicLink() && st.isDirectory(),
    isSymlink: existing === abs && st.isSymbolicLink(),
    usedCwd: !isAbsolute(rawPath),
  };
}

function globToRegex(pattern: string): RegExp | undefined {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close < 0) return;
      const body = pattern.slice(i + 1, close);
      if (!body || body.includes('/')) return;
      out += `[${body.replace(/\\/g, '\\\\')}]`;
      i = close;
    } else {
      out += ch.replace(/[.+^${}()|\\]/g, '\\$&');
    }
  }
  return new RegExp(`${out}$`, 'i');
}

function listGlobMatches(dir: string, pattern: string, opts: { allowDirs: boolean }): { names: string[]; dirEntryCount: number } | undefined {
  const re = globToRegex(pattern);
  if (!re) return;
  const names: string[] = [];
  let dirEntryCount = 0;
  try {
    const entries = opendirSync(dir);
    try {
      for (let i = 0; ; i++) {
        const item = entries.readSync();
        if (!item) break;
        if (i === MAX_WALK_ENTRIES) return;
        dirEntryCount++;
        if (!re.test(item.name)) continue;
        if (names.length === MAX_TRACKED_FILES || isSensitiveRel(item.name)) return;
        if (item.isSymbolicLink()) return;
        if (!item.isFile() && !(opts.allowDirs && item.isDirectory())) return;
        names.push(item.name);
      }
    } finally { entries.closeSync(); }
  } catch { return; }
  return { names, dirEntryCount };
}

function collectWorktreeFiles(worktreeReal: string, dir: string, recursive: boolean, out: string[], state: { seen: number }): boolean {
  try {
    const entries = opendirSync(dir);
    try {
      for (;;) {
        const item = entries.readSync();
        if (!item) break;
        if (++state.seen > MAX_WALK_ENTRIES) return false;
        if (item.isSymbolicLink() || isSensitiveRel(item.name)) return false;
        const full = join(dir, item.name);
        if (item.isDirectory()) {
          if (!recursive || !collectWorktreeFiles(worktreeReal, full, true, out, state)) return false;
        } else if (item.isFile()) {
          if (out.length >= MAX_TRACKED_FILES) return false;
          out.push(relative(worktreeReal, full));
        } else {
          return false;
        }
      }
    } finally { entries.closeSync(); }
  } catch { return false; }
  return true;
}

/** Check that every target path in the worktree matches the Git index byte-for-byte. */
function gitIndexMatches(worktreeReal: string, relPaths: string[]): boolean {
  if (!relPaths.length || relPaths.length > MAX_TRACKED_FILES) return false;
  const git = (...args: string[]) => {
    const result = spawnSync('git', [...SAFE_GIT_ARGS, '--literal-pathspecs', ...args], {
      cwd: worktreeReal, env: safeGitEnv(process.env), encoding: 'utf8', timeout: 400, maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return !result.error && result.status === 0 ? result.stdout : undefined;
  };
  if (git('rev-parse', '--show-toplevel') !== `${resolve(worktreeReal)}\n`) return false;
  const indexed = git('ls-files', '--stage', '-z', '--', ...relPaths)?.split('\0');
  if (indexed?.pop() !== '' || indexed.length !== relPaths.length) return false;
  const blobs = new Map<string, string>();
  for (const row of indexed) {
    const match = /^100(?:644|755) ([a-f0-9]+) 0\t(.+)$/.exec(row);
    if (!match) return false;
    blobs.set(match[2], match[1]);
  }
  if (!relPaths.every(path => blobs.has(path))) return false;
  // Unstaged bytes (and intent-to-add placeholders) are not preserved just because a path is indexed.
  const hashes = git('hash-object', '--no-filters', '--', ...relPaths)?.trimEnd().split('\n');
  return hashes?.length === relPaths.length && relPaths.every((path, i) => blobs.get(path) === hashes[i]);
}

type Token = { value: string; quoted: boolean };
type Redir = { mode: 'read' | 'write'; target: string };
type ParsedCommand = { tokens: Token[]; redirs: Redir[]; pipedFromPrev: boolean };

function tokenizeShell(command: string): ParsedCommand[] | undefined {
  if (!command || command.length > MAX_COMMAND_CHARS) return;
  if (/[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(command)) return;
  const commands: ParsedCommand[] = [];
  let curTokens: Token[] = [];
  let curRedirs: Redir[] = [];
  let pipedFromPrev = false;
  let totalTokens = 0;

  const pushCommand = (nextPiped: boolean) => {
    if (!curTokens.length && !curRedirs.length) {
      if (nextPiped) return false;
      return true;
    }
    if (!curTokens.length) return false;
    commands.push({ tokens: curTokens, redirs: curRedirs, pipedFromPrev });
    if (commands.length > MAX_COMMANDS) return false;
    curTokens = [];
    curRedirs = [];
    pipedFromPrev = nextPiped;
    return true;
  };

  let i = 0;
  let pendingRedir: 'read' | 'write' | undefined;
  const pushWord = (word: Token) => {
    if (++totalTokens > MAX_TOKENS) return false;
    if (pendingRedir) {
      curRedirs.push({ mode: pendingRedir, target: word.value });
      pendingRedir = undefined;
    } else {
      curTokens.push(word);
    }
    return true;
  };

  while (i < command.length) {
    const ch = command[i];
    if (ch === ' ' || ch === '\t') { i++; continue; }
    if (ch === ';' || ch === '\n') {
      if (pendingRedir || pipedFromPrev && !curTokens.length) return;
      if (!pushCommand(false)) return;
      i++; continue;
    }
    if (ch === '&' && command[i + 1] === '&') {
      if (pendingRedir || !curTokens.length) return;
      if (!pushCommand(false)) return;
      i += 2; continue;
    }
    if (ch === '|') {
      if (command[i + 1] === '|' || pendingRedir || !curTokens.length) return;
      if (!pushCommand(true)) return;
      i++; continue;
    }
    if (ch === '#' || ch === '(' || ch === ')' || ch === '`' || ch === '\\' || ch === '!') return;

    // Redirections (including 2>&1, 1>&2, 2>/dev/null, &>, >>, >, <)
    if (!pendingRedir) {
      const rest = command.slice(i);
      if (/^(?:2>&1|1>&2)(?=$|[\s;&|\n])/.test(rest)) {
        i += 4;
        continue;
      }
      const redirMatch = /^(?:(?:[12]|&)?>>?|<)/.exec(rest);
      if (redirMatch) {
        const op = redirMatch[0];
        if (op === '<' && (command[i + 1] === '<' || command[i + 1] === '(' || command[i + 1] === '&')) return;
        if (op.endsWith('>') && (command[i + op.length] === '|' || command[i + op.length] === '(' || command[i + op.length] === '&')) return;
        pendingRedir = op === '<' ? 'read' : 'write';
        i += op.length;
        continue;
      }
    }
    if (ch === '&') return;

    // Parse a word token.
    let value = '';
    let quoted = false;
    while (i < command.length) {
      const c = command[i];
      if (c === ' ' || c === '\t' || c === ';' || c === '\n' || c === '|' || c === '&' || c === '<' || c === '>') break;
      if (c === '(' || c === ')' || c === '`' || c === '\\' || c === '#') return;
      if (c === "'") {
        quoted = true;
        const end = command.indexOf("'", i + 1);
        if (end < 0) return;
        value += command.slice(i + 1, end);
        i = end + 1;
        continue;
      }
      if (c === '"') {
        quoted = true;
        i++;
        while (i < command.length && command[i] !== '"') {
          const dc = command[i];
          if (dc === '`' || dc === '\\') return;
          if (dc === '$') {
            if (command[i + 1] === '(') return;
            const varMatch = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/.exec(command.slice(i));
            if (!varMatch) return;
            value += `\0VAR:${varMatch[1] ?? varMatch[2]}\0`;
            i += varMatch[0].length;
            continue;
          }
          value += dc;
          i++;
        }
        if (i >= command.length || command[i] !== '"') return;
        i++;
        continue;
      }
      if (c === '$') {
        if (command[i + 1] === '(') return;
        const varMatch = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/.exec(command.slice(i));
        if (!varMatch) return;
        value += `\0VAR:${varMatch[1] ?? varMatch[2]}\0`;
        i += varMatch[0].length;
        continue;
      }
      if (c === '{' || c === '}') return;
      value += c;
      i++;
    }
    if (!pushWord({ value, quoted })) return;
  }
  if (pendingRedir || (pipedFromPrev && !curTokens.length)) return;
  if (!pushCommand(false)) return;
  return commands.length ? commands : undefined;
}

function expandToken(raw: string, vars: Map<string, string>): string | undefined {
  let ok = true;
  const expanded = raw.replace(/\0VAR:([A-Za-z_][A-Za-z0-9_]*)\0/g, (_m, name: string) => {
    const val = vars.get(name);
    if (val === undefined) { ok = false; return ''; }
    return val;
  });
  return ok && !expanded.includes('\0') ? expanded : undefined;
}

type StepInternal = PermissionStepProof & { canonicals: string[] };

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isShortFlagBundle(arg: string, allowed: string): boolean {
  if (arg.length < 2 || !arg.startsWith('-') || arg.startsWith('--')) return false;
  for (let i = 1; i < arg.length; i++) if (!allowed.includes(arg[i])) return false;
  return true;
}

function validateRm(
  args: string[],
  activeCwd: string | undefined,
  roots: ResolvedRoots,
): StepInternal | undefined {
  let recursive = false;
  let force = false;
  let afterDoubleDash = false;
  const rawTargets: string[] = [];
  for (const arg of args) {
    if (!afterDoubleDash && arg === '--') { afterDoubleDash = true; continue; }
    if (!afterDoubleDash && arg.startsWith('-')) {
      if (arg === '--force') { force = true; continue; }
      if (arg === '--recursive') { recursive = true; continue; }
      if (arg === '--dir' || arg === '--verbose') continue;
      if (isShortFlagBundle(arg, 'frRdv')) {
        if (arg.includes('f')) force = true;
        if (arg.includes('r') || arg.includes('R')) recursive = true;
        continue;
      }
      return;
    }
    rawTargets.push(arg);
  }
  if (!rawTargets.length) return;

  const stepRoots: PermissionRootCategory[] = [];
  const flags: PermissionFlag[] = [];
  const canonicals: string[] = [];
  if (recursive) flags.push('recursive');
  if (force) flags.push('force');

  for (const raw of rawTargets) {
    if (globChars.test(raw)) {
      flags.push('glob');
      const slash = raw.lastIndexOf('/');
      const rawDir = slash < 0 ? '.' : raw.slice(0, slash) || '/';
      const pattern = slash < 0 ? raw : raw.slice(slash + 1);
      if (!pattern || globChars.test(rawDir) || pattern === '.' || pattern === '..') return;
      const dir = resolveTargetPath(rawDir, activeCwd, roots, { mode: 'read', allowRootItself: true });
      if (!dir || !dir.exists || !dir.isDir || dir.isSymlink) return;
      if (dir.usedCwd) flags.push('verified_cwd');
      if (dir.category === 'task directory') return;
      if (dir.category === 'worktree') {
        const listed = listGlobMatches(dir.canonical, pattern, { allowDirs: recursive });
        if (!listed || !listed.names.length) return;
        const relFiles: string[] = [];
        const walkState = { seen: listed.dirEntryCount };
        for (const name of listed.names) {
          const full = join(dir.canonical, name);
          const st = lstatSync(full);
          if (st.isDirectory()) {
            if (!recursive || !collectWorktreeFiles(dir.rootReal, full, true, relFiles, walkState)) return;
          } else {
            relFiles.push(relative(dir.rootReal, full));
          }
        }
        if (!gitIndexMatches(dir.rootReal, relFiles)) return;
        stepRoots.push('worktree (Git-tracked files)');
        flags.push('git_tracked_only');
        canonicals.push(`${dir.canonical}/${pattern}`);
      } else {
        // Scratchpad or temp directory: verify no matched entry escapes via symlink (or rm unlinks inside verified dir).
        stepRoots.push(dir.category);
        canonicals.push(`${dir.canonical}/${pattern}`);
      }
      continue;
    }

    const target = resolveTargetPath(raw, activeCwd, roots, { mode: 'delete', allowRootItself: false });
    if (!target) return;
    if (target.usedCwd) flags.push('verified_cwd');
    if (target.category === 'worktree') {
      if (!target.exists || target.isSymlink) return;
      const relFiles: string[] = [];
      if (target.isDir) {
        if (!recursive || !collectWorktreeFiles(target.rootReal, target.canonical, true, relFiles, { seen: 0 })) return;
      } else {
        relFiles.push(target.rel);
      }
      if (!gitIndexMatches(target.rootReal, relFiles)) return;
      stepRoots.push('worktree (Git-tracked files)');
      flags.push('git_tracked_only');
      canonicals.push(target.canonical);
    } else {
      if (!target.exists && !force) return;
      stepRoots.push(target.category);
      canonicals.push(target.canonical);
    }
  }
  return { kind: 'housekeeping', verb: 'rm', roots: dedupe(stepRoots), flags: dedupe(flags), canonicals };
}

function validatePathOrGlob(
  raw: string,
  activeCwd: string | undefined,
  roots: ResolvedRoots,
  opts: { mode: 'read' | 'write'; allowRootItself?: boolean; allowDirs?: boolean },
): { category: PermissionRootCategory; canonical: string; usedCwd: boolean; isGlob: boolean } | undefined {
  if (!globChars.test(raw)) {
    const resolved = resolveTargetPath(raw, activeCwd, roots, opts);
    if (!resolved) return;
    return { category: resolved.category, canonical: resolved.canonical, usedCwd: resolved.usedCwd, isGlob: false };
  }
  const slash = raw.lastIndexOf('/');
  const rawDir = slash < 0 ? '.' : raw.slice(0, slash) || '/';
  const pattern = slash < 0 ? raw : raw.slice(slash + 1);
  if (!pattern || globChars.test(rawDir) || pattern === '.' || pattern === '..') return;
  const dir = resolveTargetPath(rawDir, activeCwd, roots, { mode: 'read', allowRootItself: true });
  if (!dir || !dir.exists || !dir.isDir || dir.isSymlink) return;
  const listed = listGlobMatches(dir.canonical, pattern, { allowDirs: opts.allowDirs ?? false });
  if (!listed || !listed.names.length) return;
  return { category: dir.category, canonical: `${dir.canonical}/${pattern}`, usedCwd: dir.usedCwd, isGlob: true };
}

function validateMkdir(args: string[], activeCwd: string | undefined, roots: ResolvedRoots): StepInternal | undefined {
  let afterDash = false;
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!afterDash && arg === '--') { afterDash = true; continue; }
    if (!afterDash && arg.startsWith('-')) {
      if (arg === '--parents' || arg === '--verbose' || isShortFlagBundle(arg, 'pv')) continue;
      if (arg === '-m' && i + 1 < args.length && /^0?[0-7]{3}$/.test(args[i + 1])) { i++; continue; }
      if (/^--mode=0?[0-7]{3}$/.test(arg)) continue;
      return;
    }
    paths.push(arg);
  }
  if (!paths.length) return;
  const stepRoots: PermissionRootCategory[] = [];
  const flags: PermissionFlag[] = [];
  const canonicals: string[] = [];
  for (const p of paths) {
    const r = resolveTargetPath(p, activeCwd, roots, { mode: 'write', allowRootItself: true });
    if (!r) return;
    if (r.usedCwd) flags.push('verified_cwd');
    stepRoots.push(r.category);
    canonicals.push(r.canonical);
  }
  return { kind: 'housekeeping', verb: 'mkdir', roots: dedupe(stepRoots), flags: dedupe(flags), canonicals };
}

function validateTouch(args: string[], activeCwd: string | undefined, roots: ResolvedRoots): StepInternal | undefined {
  let afterDash = false;
  const paths: string[] = [];
  for (const arg of args) {
    if (!afterDash && arg === '--') { afterDash = true; continue; }
    if (!afterDash && arg.startsWith('-')) {
      if (arg === '--no-create' || isShortFlagBundle(arg, 'cam')) continue;
      return;
    }
    paths.push(arg);
  }
  if (!paths.length) return;
  const stepRoots: PermissionRootCategory[] = [];
  const flags: PermissionFlag[] = [];
  const canonicals: string[] = [];
  for (const p of paths) {
    const r = resolveTargetPath(p, activeCwd, roots, { mode: 'write', allowRootItself: false });
    if (!r) return;
    if (r.usedCwd) flags.push('verified_cwd');
    stepRoots.push(r.category);
    canonicals.push(r.canonical);
  }
  return { kind: 'housekeeping', verb: 'touch', roots: dedupe(stepRoots), flags: dedupe(flags), canonicals };
}

function validateCpMv(verb: 'cp' | 'mv', args: string[], activeCwd: string | undefined, roots: ResolvedRoots): StepInternal | undefined {
  let afterDash = false;
  let recursive = false;
  let force = false;
  let targetDir: string | undefined;
  const paths: string[] = [];
  const allowedShort = verb === 'cp' ? 'rRapfnvuPT' : 'fnvuT';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!afterDash && arg === '--') { afterDash = true; continue; }
    if (!afterDash && arg.startsWith('-')) {
      if (arg === '-t' && i + 1 < args.length) { targetDir = args[++i]; continue; }
      if (arg.startsWith('--target-directory=')) { targetDir = arg.slice('--target-directory='.length); continue; }
      if (arg === '--force') { force = true; continue; }
      if (verb === 'cp' && (arg === '--recursive' || arg === '--archive')) { recursive = true; continue; }
      if (['--no-clobber', '--verbose', '--no-dereference'].includes(arg)) continue;
      if (isShortFlagBundle(arg, allowedShort)) {
        if (arg.includes('f')) force = true;
        if (verb === 'cp' && (arg.includes('r') || arg.includes('R') || arg.includes('a'))) recursive = true;
        continue;
      }
      return;
    }
    paths.push(arg);
  }
  const sources = targetDir ? paths : paths.slice(0, -1);
  const dest = targetDir ?? paths.at(-1);
  if (!sources.length || !dest) return;

  const stepRoots: PermissionRootCategory[] = [];
  const flags: PermissionFlag[] = [];
  const canonicals: string[] = [];
  if (recursive) flags.push('recursive');
  if (force) flags.push('force');

  for (const src of sources) {
    const r = validatePathOrGlob(src, activeCwd, roots, { mode: verb === 'mv' ? 'write' : 'read', allowRootItself: false, allowDirs: true });
    if (!r) return;
    if (r.usedCwd) flags.push('verified_cwd');
    if (r.isGlob) flags.push('glob');
    stepRoots.push(r.category);
    canonicals.push(r.canonical);
  }
  const destResolved = resolveTargetPath(dest, activeCwd, roots, { mode: 'write', allowRootItself: true });
  if (!destResolved) return;
  if (destResolved.usedCwd) flags.push('verified_cwd');
  stepRoots.push(destResolved.category);
  canonicals.push(destResolved.canonical);
  return { kind: 'housekeeping', verb, roots: dedupe(stepRoots), flags: dedupe(flags), canonicals };
}

function validateLn(args: string[], activeCwd: string | undefined, roots: ResolvedRoots): StepInternal | undefined {
  let symbolic = false;
  let force = false;
  let afterDash = false;
  const paths: string[] = [];
  for (const arg of args) {
    if (!afterDash && arg === '--') { afterDash = true; continue; }
    if (!afterDash && arg.startsWith('-')) {
      if (arg === '--symbolic') { symbolic = true; continue; }
      if (arg === '--force') { force = true; continue; }
      if (arg === '--no-dereference' || arg === '--verbose') continue;
      if (isShortFlagBundle(arg, 'sfnvT')) {
        if (arg.includes('s')) symbolic = true;
        if (arg.includes('f')) force = true;
        continue;
      }
      return;
    }
    paths.push(arg);
  }
  if (!symbolic || paths.length !== 2) return;
  const [targetRaw, linkRaw] = paths;
  const link = resolveTargetPath(linkRaw, activeCwd, roots, { mode: 'write', allowRootItself: false });
  if (!link) return;
  // Relative symlink targets resolve relative to the symlink's parent directory.
  const target = resolveTargetPath(targetRaw, activeCwd, roots, {
    mode: 'read',
    allowRootItself: true,
    cwdBase: dirname(link.canonical),
  });
  if (!target) return;
  const flags: PermissionFlag[] = ['symlink'];
  if (force) flags.push('force');
  if (link.usedCwd) flags.push('verified_cwd');
  return {
    kind: 'housekeeping',
    verb: 'ln',
    roots: dedupe([target.category, link.category]),
    flags,
    canonicals: [target.canonical, link.canonical],
  };
}

function validateChmod(args: string[], activeCwd: string | undefined, roots: ResolvedRoots): StepInternal | undefined {
  let recursive = false;
  let afterDash = false;
  const positional: string[] = [];
  for (const arg of args) {
    if (!afterDash && arg === '--') { afterDash = true; continue; }
    if (!afterDash && arg.startsWith('-') && positional.length === 0) {
      if (arg === '--recursive') { recursive = true; continue; }
      if (['--verbose', '--changes', '--silent', '--quiet'].includes(arg)) continue;
      if (isShortFlagBundle(arg, 'Rvcf')) {
        if (arg.includes('R')) recursive = true;
        continue;
      }
      // Also allow symbolic mode starting with '-' like -x? Reject to avoid flag ambiguity unless after --.
      return;
    }
    positional.push(arg);
  }
  if (positional.length < 2) return;
  const [mode, ...paths] = positional;
  const validOctal = /^0?[0-7]{3}$/.test(mode);
  const validSymbolic = /^[ugoa]*[+-=][rwxX]+(?:,[ugoa]*[+-=][rwxX]+)*$/.test(mode);
  if (!validOctal && !validSymbolic) return;
  const stepRoots: PermissionRootCategory[] = [];
  const flags: PermissionFlag[] = recursive ? ['recursive'] : [];
  const canonicals: string[] = [];
  for (const p of paths) {
    const r = resolveTargetPath(p, activeCwd, roots, { mode: 'write', allowRootItself: false });
    if (!r) return;
    if (r.usedCwd) flags.push('verified_cwd');
    stepRoots.push(r.category);
    canonicals.push(r.canonical);
  }
  return { kind: 'housekeeping', verb: 'chmod', roots: dedupe(stepRoots), flags: dedupe(flags), canonicals };
}

function validateTar(args: string[], activeCwd: string | undefined, roots: ResolvedRoots): StepInternal | undefined {
  let mode: 'extract' | 'list' | undefined;
  let archive: string | undefined;
  let destDir: string | undefined;
  let afterDash = false;
  const members: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!afterDash && arg === '--') { afterDash = true; continue; }
    if (!afterDash && arg.startsWith('-')) {
      if (arg === '--extract') { if (mode && mode !== 'extract') return; mode = 'extract'; continue; }
      if (arg === '--list') { if (mode && mode !== 'list') return; mode = 'list'; continue; }
      if (arg === '-C' || arg === '--directory') { if (i + 1 >= args.length) return; destDir = args[++i]; continue; }
      if (arg.startsWith('--directory=')) { destDir = arg.slice('--directory='.length); continue; }
      if (arg === '-f' || arg === '--file') { if (i + 1 >= args.length) return; archive = args[++i]; continue; }
      if (arg.startsWith('--file=')) { archive = arg.slice('--file='.length); continue; }
      if (/^--strip-components=\d+$/.test(arg)) continue;
      if (['--keep-old-files', '--no-same-owner', '--no-same-permissions', '--gzip', '--bzip2', '--xz', '--verbose'].includes(arg)) continue;
      if (isShortFlagBundle(arg, 'xtzfJjvko')) {
        if (arg.includes('x')) { if (mode && mode !== 'extract') return; mode = 'extract'; }
        if (arg.includes('t')) { if (mode && mode !== 'list') return; mode = 'list'; }
        if (arg.includes('f')) {
          if (!arg.endsWith('f') || i + 1 >= args.length) return;
          archive = args[++i];
        }
        continue;
      }
      return;
    }
    members.push(arg);
  }
  if (!mode || !archive || archive.includes(':')) return;
  for (const m of members) {
    if (isAbsolute(m) || m.split('/').includes('..') || isSensitiveRel(m)) return;
  }
  const arch = resolveTargetPath(archive, activeCwd, roots, { mode: 'read', allowRootItself: false });
  if (!arch) return;
  const stepRoots: PermissionRootCategory[] = [arch.category];
  const flags: PermissionFlag[] = [];
  const canonicals = [arch.canonical];
  if (arch.usedCwd) flags.push('verified_cwd');
  if (mode === 'extract') {
    flags.push('extract');
    const target = resolveTargetPath(destDir ?? '.', activeCwd, roots, { mode: 'write', allowRootItself: true });
    if (!target) return;
    if (target.usedCwd) flags.push('verified_cwd');
    stepRoots.push(target.category);
    canonicals.push(target.canonical);
  }
  return {
    kind: mode === 'extract' ? 'housekeeping' : 'read_only',
    verb: 'tar',
    roots: dedupe(stepRoots),
    flags: dedupe(flags),
    canonicals,
  };
}

function validateUnzip(args: string[], activeCwd: string | undefined, roots: ResolvedRoots): StepInternal | undefined {
  let listOnly = false;
  let destDir: string | undefined;
  let afterDash = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!afterDash && arg === '--') { afterDash = true; continue; }
    if (!afterDash && arg.startsWith('-')) {
      if (arg === '-d') { if (i + 1 >= args.length) return; destDir = args[++i]; continue; }
      if (isShortFlagBundle(arg, 'qonlvj')) {
        if (arg.includes('l')) listOnly = true;
        continue;
      }
      return;
    }
    positional.push(arg);
  }
  if (!positional.length) return;
  const [archive, ...members] = positional;
  for (const m of members) {
    if (isAbsolute(m) || m.split('/').includes('..') || isSensitiveRel(m)) return;
  }
  const arch = resolveTargetPath(archive, activeCwd, roots, { mode: 'read', allowRootItself: false });
  if (!arch) return;
  const stepRoots: PermissionRootCategory[] = [arch.category];
  const flags: PermissionFlag[] = [];
  const canonicals = [arch.canonical];
  if (arch.usedCwd) flags.push('verified_cwd');
  if (!listOnly) {
    flags.push('extract');
    const target = resolveTargetPath(destDir ?? '.', activeCwd, roots, { mode: 'write', allowRootItself: true });
    if (!target) return;
    if (target.usedCwd) flags.push('verified_cwd');
    stepRoots.push(target.category);
    canonicals.push(target.canonical);
  }
  return {
    kind: listOnly ? 'read_only' : 'housekeeping',
    verb: 'unzip',
    roots: dedupe(stepRoots),
    flags: dedupe(flags),
    canonicals,
  };
}

function validateReadOnly(
  verb: 'ls' | 'cat' | 'head' | 'tail' | 'wc' | 'diff',
  args: string[],
  activeCwd: string | undefined,
  roots: ResolvedRoots,
  hasStdin: boolean,
): StepInternal | undefined {
  let afterDash = false;
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!afterDash && arg === '--') { afterDash = true; continue; }
    if (!afterDash && arg.startsWith('-')) {
      if (verb === 'ls') {
        if (isShortFlagBundle(arg, 'aAlh1RtrSdFnis') || ['--all', '--almost-all', '--human-readable', '--recursive', '--reverse', '--directory'].includes(arg) || /^--color(?:=\w+)?$/.test(arg)) continue;
        return;
      }
      if (verb === 'cat') {
        if (isShortFlagBundle(arg, 'nbsAETv') || arg === '--number') continue;
        return;
      }
      if (verb === 'head' || verb === 'tail') {
        if (/^-\d+$/.test(arg) || isShortFlagBundle(arg, 'qv')) continue;
        if ((arg === '-n' || arg === '-c') && i + 1 < args.length && /^[+-]?\d+$/.test(args[i + 1])) { i++; continue; }
        if (/^-[nc][+-]?\d+$/.test(arg) || /^--(?:lines|bytes)=[+-]?\d+$/.test(arg)) continue;
        return;
      }
      if (verb === 'wc') {
        if (isShortFlagBundle(arg, 'lwcLm') || ['--lines', '--words', '--bytes', '--chars'].includes(arg)) continue;
        return;
      }
      if (verb === 'diff') {
        if (isShortFlagBundle(arg, 'ucrNqsiwbB') || ['--unified', '--recursive', '--brief'].includes(arg) || /^--color(?:=\w+)?$/.test(arg) || /^-U\d+$/.test(arg)) continue;
        if (arg === '-U' && i + 1 < args.length && /^\d+$/.test(args[i + 1])) { i++; continue; }
        return;
      }
    }
    paths.push(arg);
  }
  const stepRoots: PermissionRootCategory[] = [];
  const flags: PermissionFlag[] = [];
  const canonicals: string[] = [];
  if (verb === 'diff') {
    if (paths.length !== 2) return;
  } else if (!paths.length) {
    if (verb === 'ls') {
      const cwdTarget = resolveTargetPath('.', activeCwd, roots, { mode: 'read', allowRootItself: true });
      if (!cwdTarget) return;
      return { kind: 'read_only', verb, roots: [cwdTarget.category], flags: ['verified_cwd'], canonicals: [cwdTarget.canonical] };
    }
    if (!hasStdin) return;
    return { kind: 'read_only', verb, roots: [], flags: [], canonicals: [] };
  }
  for (const p of paths) {
    const r = validatePathOrGlob(p, activeCwd, roots, { mode: 'read', allowRootItself: verb === 'ls', allowDirs: verb === 'ls' || verb === 'diff' });
    if (!r) return;
    if (r.usedCwd) flags.push('verified_cwd');
    if (r.isGlob) flags.push('glob');
    stepRoots.push(r.category);
    canonicals.push(r.canonical);
  }
  return { kind: 'read_only', verb, roots: dedupe(stepRoots), flags: dedupe(flags), canonicals };
}

function validateSearch(
  verb: 'grep' | 'rg',
  args: string[],
  activeCwd: string | undefined,
  roots: ResolvedRoots,
  hasStdin: boolean,
): StepInternal | undefined {
  let afterDash = false;
  let hasExplicitPattern = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!afterDash && arg === '--') { afterDash = true; continue; }
    if (!afterDash && arg.startsWith('-')) {
      if (arg === '-e' || arg === '--regexp') { if (i + 1 >= args.length) return; hasExplicitPattern = true; i++; continue; }
      if (arg.startsWith('--regexp=')) { hasExplicitPattern = true; continue; }
      if (['-m', '-A', '-B', '-C', '--max-count', '--after-context', '--before-context', '--context'].includes(arg)) {
        if (i + 1 >= args.length || !/^\d+$/.test(args[i + 1])) return;
        i++; continue;
      }
      if (/^-[ABCm]\d+$/.test(arg)) continue;
      if (verb === 'rg' && (arg === '-g' || arg === '--glob' || arg === '-t' || arg === '--type' || arg === '-T' || arg === '--type-not')) {
        if (i + 1 >= args.length) return;
        i++; continue;
      }
      if (verb === 'rg' && /^--(?:glob|type|type-not|color)=/.test(arg)) continue;
      if (verb === 'grep' && /^--(?:include|exclude|exclude-dir|color)=/.test(arg)) continue;
      if (['--ignore-case', '--invert-match', '--line-number', '--count', '--files-with-matches', '--files-without-match',
        '--only-matching', '--word-regexp', '--fixed-strings', '--extended-regexp', '--recursive', '--quiet',
        '--smart-case', '--files', '--no-heading', '--with-filename', '--no-filename'].includes(arg)) continue;
      const allowedShort = verb === 'rg' ? 'ivnclLhowxFEqsS' : 'ivnclLhowxFErRqsa';
      if (isShortFlagBundle(arg, allowedShort)) continue;
      return;
    }
    positional.push(arg);
  }
  const paths = hasExplicitPattern ? positional : positional.slice(1);
  if (!hasExplicitPattern && positional.length === 0 && !args.includes('--files')) return;
  const stepRoots: PermissionRootCategory[] = [];
  const flags: PermissionFlag[] = [];
  const canonicals: string[] = [];
  if (!paths.length) {
    if (hasStdin) return { kind: 'read_only', verb, roots: [], flags: [], canonicals: [] };
    const cwdTarget = resolveTargetPath('.', activeCwd, roots, { mode: 'read', allowRootItself: true });
    if (!cwdTarget) return;
    return { kind: 'read_only', verb, roots: [cwdTarget.category], flags: ['verified_cwd'], canonicals: [cwdTarget.canonical] };
  }
  for (const p of paths) {
    const r = validatePathOrGlob(p, activeCwd, roots, { mode: 'read', allowRootItself: true, allowDirs: true });
    if (!r) return;
    if (r.usedCwd) flags.push('verified_cwd');
    if (r.isGlob) flags.push('glob');
    stepRoots.push(r.category);
    canonicals.push(r.canonical);
  }
  return { kind: 'read_only', verb, roots: dedupe(stepRoots), flags: dedupe(flags), canonicals };
}

function validateFind(args: string[], activeCwd: string | undefined, roots: ResolvedRoots): StepInternal | undefined {
  let i = 0;
  const rawStarts: string[] = [];
  while (i < args.length && !args[i].startsWith('-') && args[i] !== '!' && args[i] !== '(') {
    rawStarts.push(args[i++]);
  }
  let hasDelete = false;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-delete') { hasDelete = true; continue; }
    if (['-not', '-and', '-or', '-a', '-o', '-print', '-print0', '-empty', '-prune'].includes(arg)) continue;
    if (['-name', '-iname', '-path', '-type', '-maxdepth', '-mindepth', '-size', '-mtime'].includes(arg)) {
      if (i + 1 >= args.length) return;
      i++; continue;
    }
    // Reject -exec, -execdir, -ok, -okdir, -fprint*, -L, -H, and unknown predicates.
    return;
  }
  const starts = rawStarts.length ? rawStarts : ['.'];
  const stepRoots: PermissionRootCategory[] = [];
  const flags: PermissionFlag[] = [];
  const canonicals: string[] = [];
  for (const s of starts) {
    const r = resolveTargetPath(s, activeCwd, roots, { mode: 'read', allowRootItself: true });
    if (!r) return;
    if (r.usedCwd) flags.push('verified_cwd');
    // Allow -delete only inside regenerable scratchpad or temp directories.
    if (hasDelete && !['scratchpad', 'task scratchpad', 'temporary directory'].includes(r.category)) return;
    stepRoots.push(r.category);
    canonicals.push(r.canonical);
  }
  return {
    kind: hasDelete ? 'housekeeping' : 'read_only',
    verb: 'find',
    roots: dedupe(stepRoots),
    flags: dedupe(flags),
    canonicals,
  };
}

function requireWorktreeCwd(activeCwd: string | undefined, roots: ResolvedRoots): string | undefined {
  if (!activeCwd || !roots.worktree || !inside(roots.worktree, activeCwd)) return;
  return activeCwd;
}

function isSafeBuildArg(arg: string, activeCwd: string, roots: ResolvedRoots): boolean {
  if (arg === '~' || arg.startsWith('~/') || arg.startsWith('~') || arg.split('/').includes('..')) return false;
  if (arg.startsWith('-')) {
    const eq = arg.indexOf('=');
    if (eq > 0) return isSafeBuildArg(arg.slice(eq + 1), activeCwd, roots);
    return true;
  }
  if (isAbsolute(arg)) return !!resolveTargetPath(arg, activeCwd, roots, { mode: 'read', allowRootItself: true });
  if (isSensitiveRel(arg)) return false;
  return true;
}

function validateLocalBuild(
  verb: 'node' | 'npm' | 'npx' | 'cargo',
  args: string[],
  activeCwd: string | undefined,
  roots: ResolvedRoots,
): StepInternal | undefined {
  const wtCwd = requireWorktreeCwd(activeCwd, roots);
  if (!wtCwd) return;
  const canonicals = [wtCwd];

  if (verb === 'npm') {
    const sub = args[0];
    if (sub === 'test') {
      for (const a of args.slice(1)) {
        if (['--silent', '-s', '--if-present', '--'].includes(a) || /^--workspace=[\w@./-]+$/.test(a)) continue;
        if (!isSafeBuildArg(a, wtCwd, roots)) return;
      }
      return { kind: 'local_build', verb: 'npm test', roots: ['worktree'], flags: ['verified_cwd'], canonicals };
    }
    if (sub !== 'run' || !args[1] || !/^[A-Za-z0-9:._-]+$/.test(args[1])) return;
    let afterDash = false;
    for (let i = 2; i < args.length; i++) {
      const a = args[i];
      if (!afterDash && a === '--') { afterDash = true; continue; }
      if (!afterDash) {
        if (['--silent', '-s', '--if-present'].includes(a) || /^--workspace=[\w@./-]+$/.test(a)) continue;
        if (a === '-w' && i + 1 < args.length && /^[\w@./-]+$/.test(args[i + 1])) { i++; continue; }
        return;
      }
      if (!isSafeBuildArg(a, wtCwd, roots)) return;
    }
    return { kind: 'local_build', verb: 'npm run', roots: ['worktree'], flags: ['verified_cwd'], canonicals };
  }

  if (verb === 'npx') {
    let i = 0;
    while (i < args.length && (args[i] === '--no-install' || args[i] === '--no')) i++;
    if (args[i] !== 'tsc') return;
    for (let j = i + 1; j < args.length; j++) {
      const a = args[j];
      if (a === '-p' || a === '--project' || a === '--outDir') {
        if (j + 1 >= args.length) return;
        const target = resolveTargetPath(args[++j], wtCwd, roots, { mode: a === '--outDir' ? 'write' : 'read', allowRootItself: true });
        if (!target || target.category !== 'worktree') return;
        canonicals.push(target.canonical);
        continue;
      }
      if (!isSafeBuildArg(a, wtCwd, roots)) return;
    }
    return { kind: 'local_build', verb: 'npx tsc', roots: ['worktree'], flags: ['verified_cwd'], canonicals };
  }

  if (verb === 'cargo') {
    const sub = args[0];
    if (sub !== 'build' && sub !== 'test' && sub !== 'check') return;
    let afterDash = false;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (!afterDash && a === '--') { afterDash = true; continue; }
      if (!afterDash) {
        if (a === '--config' || a.startsWith('--config=') || a === '-Z') return;
        if (a === '--manifest-path' || a === '--target-dir') {
          if (i + 1 >= args.length) return;
          const target = resolveTargetPath(args[++i], wtCwd, roots, { mode: a === '--target-dir' ? 'write' : 'read', allowRootItself: true });
          if (!target || target.category !== 'worktree') return;
          canonicals.push(target.canonical);
          continue;
        }
        if (/^--(?:manifest-path|target-dir)=/.test(a)) {
          const val = a.slice(a.indexOf('=') + 1);
          const target = resolveTargetPath(val, wtCwd, roots, { mode: a.startsWith('--target-dir=') ? 'write' : 'read', allowRootItself: true });
          if (!target || target.category !== 'worktree') return;
          canonicals.push(target.canonical);
          continue;
        }
      }
      if (!isSafeBuildArg(a, wtCwd, roots)) return;
    }
    return { kind: 'local_build', verb: `cargo ${sub}`, roots: ['worktree'], flags: ['verified_cwd'], canonicals };
  }

  // verb === 'node'
  let testMode = false;
  let scriptPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!scriptPath && a.startsWith('-')) {
      if (a === '--test') { testMode = true; continue; }
      if (['-v', '--version', '--check', '--no-warnings', '--enable-source-maps'].includes(a) ||
        /^--test-(?:name-pattern|concurrency|reporter|timeout)=/.test(a)) continue;
      // Reject -e/--eval/-p/--print/-r/--require/--import/--loader/-i and unknown node runtime flags.
      return;
    }
    if (!scriptPath || testMode) {
      const target = resolveTargetPath(a, wtCwd, roots, { mode: 'read', allowRootItself: false });
      if (!target || target.category !== 'worktree') return;
      scriptPath ??= target.canonical;
      canonicals.push(target.canonical);
      continue;
    }
    if (!isSafeBuildArg(a, wtCwd, roots)) return;
  }
  if (!scriptPath && !testMode && !args.includes('-v') && !args.includes('--version')) return;
  return { kind: 'local_build', verb: 'node', roots: ['worktree'], flags: ['verified_cwd'], canonicals };
}

const ALLOWED_GIT_SUBS = new Set(['status', 'diff', 'log', 'show', 'add', 'commit', 'restore', 'stash', 'rebase']);

function validateGit(args: string[], activeCwd: string | undefined, roots: ResolvedRoots): StepInternal | undefined {
  let gitCwd = activeCwd;
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i];
    if (a === '--no-pager' || a === '-P') { i++; continue; }
    if (a === '-C' && i + 1 < args.length) {
      const target = resolveTargetPath(args[i + 1], gitCwd, roots, { mode: 'read', allowRootItself: true });
      if (!target || !target.exists || !target.isDir || target.category !== 'worktree') return;
      gitCwd = target.canonical;
      i += 2; continue;
    }
    return;
  }
  const wtCwd = requireWorktreeCwd(gitCwd, roots);
  if (!wtCwd || i >= args.length) return;
  const sub = args[i++];
  if (!ALLOWED_GIT_SUBS.has(sub)) return;
  const rest = args.slice(i);
  const canonicals = [wtCwd];

  const checkPath = (p: string, mode: 'read' | 'write') => {
    const target = resolveTargetPath(p, wtCwd, roots, { mode, allowRootItself: true });
    if (!target || target.category !== 'worktree') return false;
    canonicals.push(target.canonical);
    return true;
  };
  const checkRefOrPath = (arg: string) => {
    if (arg === '~' || arg.startsWith('~/') || arg.startsWith('~')) return false;
    if (arg.split('/').includes('..')) return false;
    if (arg.includes(':')) {
      const afterColon = arg.slice(arg.indexOf(':') + 1);
      if (afterColon && isSensitiveRel(afterColon)) return false;
    }
    if (isAbsolute(arg)) return checkPath(arg, 'read');
    if (isSensitiveRel(arg)) return false;
    return true;
  };

  if (sub === 'stash') {
    const action = rest[0];
    if (action && !action.startsWith('-') && !['list', 'show', 'pop', 'apply', 'save'].includes(action)) return;
    for (const a of rest) if (!checkRefOrPath(a)) return;
  } else if (sub === 'rebase') {
    for (const a of rest) {
      if (a === '-i' || a === '--interactive' || a === '-x' || a === '--exec' || a.startsWith('--exec=')) return;
      if (!a.startsWith('-') && !checkRefOrPath(a)) return;
    }
  } else if (sub === 'add' || sub === 'restore') {
    let afterDash = false;
    for (let j = 0; j < rest.length; j++) {
      const a = rest[j];
      if (!afterDash && a === '--') { afterDash = true; continue; }
      if (!afterDash && a.startsWith('-')) {
        if (sub === 'restore' && (a === '-s' || a === '--source')) { if (j + 1 >= rest.length) return; j++; continue; }
        if (sub === 'restore' && a.startsWith('--source=')) continue;
        if (sub === 'add' && (['-A', '--all', '-u', '--update', '-N', '--intent-to-add', '-v', '--verbose', '-n', '--dry-run'].includes(a))) continue;
        if (sub === 'restore' && (['-S', '--staged', '-W', '--worktree'].includes(a))) continue;
        return;
      }
      if (!checkPath(a, 'write')) return;
    }
  } else if (sub === 'commit') {
    let afterDash = false;
    for (let j = 0; j < rest.length; j++) {
      const a = rest[j];
      if (!afterDash && a === '--') { afterDash = true; continue; }
      if (!afterDash && a.startsWith('-')) {
        if (a === '-m' || a === '--message') { if (j + 1 >= rest.length) return; j++; continue; }
        if (a.startsWith('--message=')) continue;
        if (['-a', '--all', '--amend', '--no-edit', '--allow-empty', '-s', '--signoff', '-v', '--verbose'].includes(a)) continue;
        return;
      }
      if (!checkPath(a, 'write')) return;
    }
  } else {
    // status, diff, log, show
    let afterDash = false;
    for (const a of rest) {
      if (!afterDash && a === '--') { afterDash = true; continue; }
      if (!afterDash && a.startsWith('-')) {
        if (a === '--no-index' || a === '--ext-diff' || a.startsWith('--output')) return;
        continue;
      }
      if (afterDash) {
        if (!checkPath(a, 'read')) return;
      } else if (!checkRefOrPath(a)) return;
    }
  }
  return { kind: 'git_local', verb: `git ${sub}`, roots: ['worktree'], flags: ['verified_cwd'], canonicals };
}

function summarizeProof(operations: PermissionStepProof[], roots: PermissionRootCategory[]): string {
  const labels = dedupe(operations.map(op => {
    if (op.kind === 'file_edit') return 'Edit file';
    if (op.kind === 'file_write') return 'Write file';
    if (op.kind === 'file_create') return 'Create file';
    if (op.verb === 'rm') {
      const details: string[] = [];
      if (op.flags.includes('recursive')) details.push('-r');
      if (op.flags.includes('force')) details.push('-f');
      if (op.flags.includes('glob')) details.push('glob');
      return details.length ? `rm (${details.join(', ')})` : 'rm';
    }
    return op.verb;
  }));
  const rootText = roots.length ? ` in the job’s ${roots.join(' and ')}` : '';
  return `${labels.join(', ')}${rootText}`;
}

function proveFilePrompt(target: FilePromptTarget, roots: ResolvedRoots): PermissionProof | undefined {
  if (!target.paths.length || target.paths.length > 32) return;
  const stepRoots: PermissionRootCategory[] = [];
  const flags: PermissionFlag[] = [];
  const canonicals: string[] = [];
  for (const raw of target.paths) {
    const resolved = resolveTargetPath(raw, roots.verifiedCwd, roots, { mode: 'write', allowRootItself: false });
    if (!resolved) return;
    if (resolved.usedCwd) flags.push('verified_cwd');
    stepRoots.push(resolved.category);
    canonicals.push(resolved.canonical);
  }
  const verb = target.kind === 'file_create' ? 'create' : target.kind === 'file_write' ? 'write' : 'edit';
  const uniqueRoots = dedupe(stepRoots);
  const op: PermissionStepProof = { kind: target.kind, verb, roots: uniqueRoots, flags: dedupe(flags) };
  return {
    operations: [op],
    roots: uniqueRoots,
    summary: summarizeProof([op], uniqueRoots),
    fingerprint: JSON.stringify({ op, canonicals }),
  };
}

function proveShellPrompt(command: string, roots: ResolvedRoots): PermissionProof | undefined {
  const parsed = tokenizeShell(command);
  if (!parsed) return;
  const vars = new Map<string, string>();
  let activeCwd = roots.verifiedCwd;
  const operations: PermissionStepProof[] = [];
  const allCanonicals: string[] = [];

  for (const cmd of parsed) {
    // Handle standalone literal variable assignments (e.g. S=/path/to/scratch; rm -rf $S/out).
    if (!cmd.pipedFromPrev && !cmd.redirs.length && cmd.tokens.length === 1 && !cmd.tokens[0].quoted) {
      const assign = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(cmd.tokens[0].value);
      if (assign) {
        const [, name, rawVal] = assign;
        if (FORBIDDEN_ASSIGN_VARS.has(name) || name.startsWith('NPM_CONFIG_') || rawVal.includes('\0')) return;
        const resolved = resolveTargetPath(rawVal, activeCwd, roots, { mode: 'read', allowRootItself: true });
        if (!resolved) return;
        vars.set(name, resolved.canonical);
        continue;
      }
    }

    const words: string[] = [];
    for (const token of cmd.tokens) {
      const expanded = expandToken(token.value, vars);
      if (expanded === undefined) return;
      words.push(expanded);
    }
    const [verb, ...args] = words;
    if (!verb) return;
    if (cmd.pipedFromPrev && !READ_ONLY_PIPE_SINKS.has(verb)) return;

    // Validate redirections for this simple command.
    const redirRoots: PermissionRootCategory[] = [];
    const redirFlags: PermissionFlag[] = [];
    const redirCanonicals: string[] = [];
    let hasStdinRedir = false;
    for (const redir of cmd.redirs) {
      const target = expandToken(redir.target, vars);
      if (!target) return;
      if (target === '/dev/null') {
        redirFlags.push(redir.mode === 'read' ? 'redirect_read' : 'redirect_write');
        if (redir.mode === 'read') hasStdinRedir = true;
        continue;
      }
      const resolved = resolveTargetPath(target, activeCwd, roots, { mode: redir.mode, allowRootItself: false });
      if (!resolved) return;
      redirRoots.push(resolved.category);
      redirFlags.push(redir.mode === 'read' ? 'redirect_read' : 'redirect_write');
      if (resolved.usedCwd) redirFlags.push('verified_cwd');
      if (redir.mode === 'read') hasStdinRedir = true;
      redirCanonicals.push(resolved.canonical);
    }

    if (verb === 'cd') {
      if (cmd.pipedFromPrev || cmd.redirs.length) return;
      const cdArgs = args[0] === '--' ? args.slice(1) : args;
      if (cdArgs.length !== 1 || cdArgs[0] === '-' || cdArgs[0].startsWith('-')) return;
      const resolved = resolveTargetPath(cdArgs[0], activeCwd, roots, { mode: 'read', allowRootItself: true });
      if (!resolved || !resolved.exists || !resolved.isDir) return;
      activeCwd = resolved.canonical;
      allCanonicals.push(`cd:${resolved.canonical}`);
      continue;
    }

    const hasStdin = cmd.pipedFromPrev || hasStdinRedir;
    let step: StepInternal | undefined;
    switch (verb) {
      case 'rm': step = validateRm(args, activeCwd, roots); break;
      case 'mkdir': step = validateMkdir(args, activeCwd, roots); break;
      case 'touch': step = validateTouch(args, activeCwd, roots); break;
      case 'cp':
      case 'mv': step = validateCpMv(verb, args, activeCwd, roots); break;
      case 'ln': step = validateLn(args, activeCwd, roots); break;
      case 'chmod': step = validateChmod(args, activeCwd, roots); break;
      case 'tar': step = validateTar(args, activeCwd, roots); break;
      case 'unzip': step = validateUnzip(args, activeCwd, roots); break;
      case 'ls':
      case 'cat':
      case 'head':
      case 'tail':
      case 'wc':
      case 'diff': step = validateReadOnly(verb, args, activeCwd, roots, hasStdin); break;
      case 'grep':
      case 'rg': step = validateSearch(verb, args, activeCwd, roots, hasStdin); break;
      case 'find': step = validateFind(args, activeCwd, roots); break;
      case 'node':
      case 'npm':
      case 'npx':
      case 'cargo': step = validateLocalBuild(verb, args, activeCwd, roots); break;
      case 'git': step = validateGit(args, activeCwd, roots); break;
      default: return;
    }
    if (!step) return;
    const stepRoots = dedupe([...step.roots, ...redirRoots]);
    const stepFlags = dedupe([...step.flags, ...redirFlags, ...(cmd.pipedFromPrev ? (['pipe'] as const) : [])]);
    operations.push({ kind: step.kind, verb: step.verb, roots: stepRoots, flags: stepFlags });
    allCanonicals.push(...step.canonicals, ...redirCanonicals);
  }

  if (!operations.length) return;
  const allRoots = dedupe(operations.flatMap(op => op.roots));
  if (!allRoots.length) return;
  return {
    operations,
    roots: allRoots,
    summary: summarizeProof(operations, allRoots),
    fingerprint: JSON.stringify({ operations, canonicals: allCanonicals }),
  };
}

/** Locally prove that a worker file or shell permission prompt stays low-risk inside the job's own roots. */
export function provePermission(target: PermissionTarget | string | undefined, roots: PermissionRoots): PermissionProof | undefined {
  if (!target) return;
  const resolved = resolveRoots(roots);
  if (!resolved.ordered.length) return;
  if (typeof target === 'string') return proveShellPrompt(target, resolved);
  return target.kind === 'shell' ? proveShellPrompt(target.command, resolved) : proveFilePrompt(target, resolved);
}

/** Compatibility helper returning the primary verified root category for a locally proven command. */
export function permissionProof(command: string | undefined, roots: PermissionRoots): string | undefined {
  return provePermission(command, roots)?.roots[0];
}

const reasons = {
  approve: 'The locally verified operation stays inside the job’s own roots and involves no network writes, secrets, git push or installation.',
  outside: 'The operation is not proven to stay inside this job’s roots.',
  irreversible: 'The operation is not proven reversible or regenerable.',
  restricted: 'The operation may involve network writes, secrets, git push or installation.',
  unsure: 'HUD could not prove that this operation is low risk.',
} as const;
const choices = Object.keys(reasons) as (keyof typeof reasons)[];

function normalizeProof(proof: PermissionProof | string | undefined): PermissionProof | undefined {
  if (!proof) return;
  if (typeof proof !== 'string') return proof;
  const root = proof as PermissionRootCategory;
  const op: PermissionStepProof = { kind: 'housekeeping', verb: 'rm', roots: [root], flags: ['force', 'glob'] };
  return { operations: [op], roots: [root], summary: summarizeProof([op], [root]), fingerprint: proof };
}

/** Only structural evidence leaves the machine: never send command arguments, environment or absolute paths. */
export async function classifyPermission(
  home: string,
  proof: PermissionProof | string | undefined,
  decide = dispatchDecision,
): Promise<PermissionDecision> {
  const verified = normalizeProof(proof);
  const fallback: PermissionDecision = verified
    ? { action: 'approve', reason: `Local path check: verified ${verified.summary}.` }
    : { action: 'main', reason: reasons.unsure };
  try {
    const { result } = await decide(home, loadSettings({ ...process.env, HUD_HOME: home }), 'worker-permission', {
      page: { url: '', title: 'Worker permission prompt', text: '' }, elements: [], statements: [], deltas: {},
      facts: verified
        ? {
            verified: true,
            operations: verified.operations.map(op => ({
              kind: op.kind,
              verb: op.verb,
              roots: op.roots,
              flags: op.flags,
            })),
            roots: verified.roots,
          }
        : { verified: false, operations: [], roots: [] },
      choices: [{
        name: 'permission',
        statement: 'Classify a native worker permission prompt from the quoted structural facts only. Approve only when verified is true and every operation is a locally proven low-risk file edit, file housekeeping, read-only inspection, local build/test, or local git command confined to the job’s own worktree, task directory, scratchpad or dedicated temp directory, with no network write, secrets, git push, installs, privilege escalation or paths outside the job’s roots. If anything is missing or uncertain, hand to main and choose the best reason. Never deny.',
        choices: choices.map(value => ({ value, description: reasons[value] })),
      }],
    });
    const reason = result && dispatchChoice(result, 'permission', choices);
    if (reason && reason !== 'approve') return { action: 'main', reason: `Decision model: ${reasons[reason]}` };
    if (reason === 'approve' && verified) {
      return { action: 'approve', reason: `Decision model and local path check: verified ${verified.summary}.` };
    }
  } catch { /* Missing credentials, invalid output or timeout: local proof only. */ }
  return fallback;
}
