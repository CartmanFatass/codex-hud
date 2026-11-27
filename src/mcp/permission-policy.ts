import { spawnSync } from 'node:child_process';
import { accessSync, constants, lstatSync, opendirSync, realpathSync, statSync, type Dirent, type Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { loadSettings } from '../settings.js';
import { SAFE_GIT_ARGS, safeGitEnv } from '../utils/git-safety.js';
import { dispatchChoice, dispatchDecision } from './dispatch-decision.js';
import { jobFiles } from './paths.js';

export type PermissionDecision = { action: 'approve' | 'main'; reason: string };
export type PermissionRoots = {
  task: string;
  worktree?: string;
  /** Verifiable shell cwd from the prompt or worker process (/proc/<pid>/cwd); never job.cwd. */
  cwd?: string;
  path?: string;
};
export type PermissionRootCategory =
  | 'scratchpad'
  | 'task scratchpad'
  | 'worktree'
  | 'worktree (Git-tracked files)'
  | 'task directory';
export type PermissionOpKind =
  | 'file_edit'
  | 'file_write'
  | 'file_create'
  | 'housekeeping'
  | 'read_only';
export type PermissionFlag =
  | 'recursive'
  | 'force'
  | 'glob'
  | 'symlink'
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

const globChars = /[*?\[\]]/;
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

const READ_ONLY_PIPE_SINKS = new Set(['head', 'tail', 'wc', 'grep', 'rg', 'cat', 'diff']);

type VerifiedRoot = { category: PermissionRootCategory; real: string };
type ResolvedRoots = {
  ordered: VerifiedRoot[];
  worktree?: string;
  verifiedCwd?: string;
  path: string;
};

function verifyRootDir(dir: string | undefined, opts?: { anchor?: string; rejectSymlink?: boolean }): string | undefined {
  if (!dir || !isAbsolute(dir)) return;
  try {
    const lst = lstatSync(dir);
    if (opts?.rejectSymlink && lst.isSymbolicLink()) return;
    const real = realpathSync(dir);
    const st = statSync(real);
    const uid = process.getuid?.();
    if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) return;
    if (opts?.anchor && (!inside(opts.anchor, real) || real === opts.anchor)) return;
    return real;
  } catch { return; }
}

function resolveRoots(roots: PermissionRoots): ResolvedRoots {
  const ordered: VerifiedRoot[] = [];
  const seen = new Set<string>();
  const add = (category: PermissionRootCategory, dir: string | undefined, opts?: { anchor?: string; rejectSymlink?: boolean }) => {
    const real = verifyRootDir(dir, opts);
    if (!real || seen.has(real)) return;
    seen.add(real);
    ordered.push({ category, real });
  };
  const worktree = verifyRootDir(roots.worktree);
  const task = verifyRootDir(roots.task);
  if (worktree) add('scratchpad', join(worktree, 'scratchpad'), { anchor: worktree, rejectSymlink: true });
  if (task) add('task scratchpad', join(task, 'scratchpad'), { anchor: task, rejectSymlink: true });
  if (worktree) add('worktree', worktree);
  if (task) add('task directory', task);
  const cwdReal = verifyRootDir(roots.cwd);
  const verifiedCwd = cwdReal && worktree && inside(worktree, cwdReal) ? cwdReal : undefined;
  return { ordered, worktree, verifiedCwd, path: roots.path ?? process.env.PATH ?? '' };
}

const SYSTEM_PATH = '/usr/bin:/bin';
const SYSTEM_DIRS = new Set(SYSTEM_PATH.split(':'));

function trustedExecutable(verb: string, path: string): string | undefined {
  if (!/^[a-z]+$/.test(verb)) return;
  for (const dir of path.split(':')) {
    // A relative/empty PATH component is cwd-dependent. Do not guess what it resolves to.
    if (!isAbsolute(dir)) return;
    const candidate = `${dir}/${verb}`; // Preserve kernel resolution of symlink/.. in an earlier PATH entry.
    try {
      const st = statSync(candidate);
      if (st.isDirectory()) continue;
      accessSync(candidate, constants.X_OK);
      if (!st.isFile() || st.uid !== 0 || (st.mode & 0o022) || !SYSTEM_DIRS.has(dir)) return;
      const real = realpathSync(candidate);
      if (SYSTEM_DIRS.has(dirname(real))) return real;
      return;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
    }
  }
}

type ResolvedTarget = {
  canonical: string;
  category: PermissionRootCategory;
  rootReal: string;
  rel: string;
  exists: boolean;
  isDir: boolean;
  isFile: boolean;
  isSymlink: boolean;
  singleLink: boolean;
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
    isDir: existing === abs && st.isDirectory(),
    isFile: existing === abs && st.isFile(),
    isSymlink: existing === abs && st.isSymbolicLink(),
    singleLink: st.nlink === 1,
    usedCwd: !isAbsolute(rawPath),
  };
}

function listGlobMatches(dir: string, pattern: string, allowDirs: boolean): { matches: Dirent[]; dirEntryCount: number } | undefined {
  // One basename only, with literal ASCII characters and ordinary * / ? wildcards, never globstar.
  if (!/^[A-Za-z0-9_.?*-]+$/.test(pattern) || pattern.includes('**')) return;
  const matches: Dirent[] = [];
  let dirEntryCount = 0;
  try {
    const body = pattern.replace(/[.*?]/g, ch => ch === '*' ? '.*' : ch === '?' ? '.' : '\\.');
    // Include case-folded and dotfile candidates conservatively; never miss a shell-option match.
    const re = new RegExp(`^${body}$`, 'isu');
    const entries = opendirSync(dir);
    try {
      for (let i = 0; ; i++) {
        const item = entries.readSync();
        if (!item) break;
        if (i === MAX_WALK_ENTRIES) return;
        dirEntryCount++;
        if (pattern.includes('?') && /[^\x00-\x7f]/.test(item.name)) return; // ? is locale-dependent.
        if (!re.test(item.name)) continue;
        if (matches.length === MAX_TRACKED_FILES || isSensitiveRel(item.name)) return;
        if (!item.isFile() && !(allowDirs && item.isDirectory())) return;
        matches.push(item);
      }
    } finally { entries.closeSync(); }
  } catch { return; }
  return { matches, dirEntryCount };
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
  const executable = trustedExecutable('git', SYSTEM_PATH);
  if (!executable) return false;
  const git = (args: string[], input?: string) => {
    const result = spawnSync(executable, [...SAFE_GIT_ARGS, '--literal-pathspecs', ...args], {
      cwd: worktreeReal, env: safeGitEnv(process.env), encoding: 'utf8', timeout: 400, maxBuffer: 1024 * 1024,
      input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
    });
    return !result.error && result.status === 0 ? result.stdout : undefined;
  };
  if (git(['rev-parse', '--show-toplevel']) !== `${resolve(worktreeReal)}\n`) return false;
  const indexed = git(['ls-files', '--stage', '-z', '--', ...relPaths])?.split('\0');
  if (indexed?.pop() !== '' || indexed.length !== relPaths.length) return false;
  const blobs = new Map<string, string>();
  for (const row of indexed) {
    const match = /^100(?:644|755) ([a-f0-9]+) 0\t(.+)$/.exec(row);
    if (!match) return false;
    blobs.set(match[2], match[1]);
  }
  if (!relPaths.every(path => blobs.has(path))) return false;
  // Unstaged bytes (and intent-to-add placeholders) are not preserved just because a path is indexed.
  const hashes = git(['hash-object', '--no-filters', '--', ...relPaths])?.trimEnd().split('\n');
  if (hashes?.length !== relPaths.length || !relPaths.every((path, i) => blobs.get(path) === hashes[i])) return false;
  // An index entry alone need not have a local recovery blob.
  const unique = [...new Set(hashes)];
  const objects = git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], `${unique.join('\n')}\n`);
  return objects === unique.map(hash => `${hash} blob\n`).join('');
}

const SCRATCH_VAR = '\0S\0';
const SCRATCH_VAR_PATTERN = /^\$(?:\{S\}|S(?![A-Za-z0-9_]))/;
type Token = { value: string; quoted: boolean };
type Redir = { mode: 'read' | 'write'; target: string };
type Separator = 'seq' | 'and' | 'pipe';
type ParsedCommand = {
  tokens: Token[];
  redirs: Redir[];
  pipedFromPrev: boolean;
  pipedToNext: boolean;
  sepBefore?: Separator;
};

function tokenizeShell(command: string): ParsedCommand[] | undefined {
  if (!command || command.length > MAX_COMMAND_CHARS) return;
  if (/[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(command)) return;
  const commands: ParsedCommand[] = [];
  let curTokens: Token[] = [];
  let curRedirs: Redir[] = [];
  let sepBefore: Separator | undefined;
  let totalTokens = 0;

  const pushCommand = (nextSep?: Separator) => {
    if (!curTokens.length && !curRedirs.length) {
      if (nextSep === 'pipe' || nextSep === 'and') return false;
      return true;
    }
    if (!curTokens.length) return false;
    commands.push({
      tokens: curTokens,
      redirs: curRedirs,
      pipedFromPrev: sepBefore === 'pipe',
      pipedToNext: nextSep === 'pipe',
      sepBefore,
    });
    if (commands.length > MAX_COMMANDS) return false;
    curTokens = [];
    curRedirs = [];
    sepBefore = nextSep;
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
      if (pendingRedir || ((sepBefore === 'pipe' || sepBefore === 'and') && !curTokens.length)) return;
      if (!pushCommand('seq')) return;
      i++; continue;
    }
    if (ch === '&' && command[i + 1] === '&') {
      if (pendingRedir || !curTokens.length) return;
      if (!pushCommand('and')) return;
      i += 2; continue;
    }
    if (ch === '|') {
      if (command[i + 1] === '|' || pendingRedir || !curTokens.length) return;
      if (!pushCommand('pipe')) return;
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
    let wildcard = false;
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
            const varMatch = SCRATCH_VAR_PATTERN.exec(command.slice(i));
            if (!varMatch) return;
            value += SCRATCH_VAR;
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
        const varMatch = SCRATCH_VAR_PATTERN.exec(command.slice(i));
        if (!varMatch) return;
        value += SCRATCH_VAR;
        i += varMatch[0].length;
        continue;
      }
      if (c === '{' || c === '}' || c === '[' || c === ']') return;
      if (c === '*' || c === '?') wildcard = true;
      value += c;
      i++;
    }
    if ((wildcard && quoted) || !pushWord({ value, quoted })) return;
  }
  if (pendingRedir || ((sepBefore === 'pipe' || sepBefore === 'and') && !curTokens.length)) return;
  if (!pushCommand(undefined)) return;
  return commands.length ? commands : undefined;
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
      if (slash < 0) return; // Matches must retain a path prefix, not expand into rm options.
      const dir = resolveTargetPath(raw.slice(0, slash) || '/', activeCwd, roots, { mode: 'read', allowRootItself: true });
      if (!dir?.isDir || dir.category === 'task directory') return;
      if (dir.usedCwd) flags.push('verified_cwd');
      const pattern = raw.slice(slash + 1);
      const listed = listGlobMatches(dir.canonical, pattern, recursive);
      if (!listed || (!listed.matches.length && !force)) return;
      if (dir.category === 'worktree') {
        const relFiles: string[] = [];
        const walkState = { seen: listed.dirEntryCount };
        for (const item of listed.matches) {
          const full = join(dir.canonical, item.name);
          if (item.isDirectory()) {
            if (!collectWorktreeFiles(dir.rootReal, full, true, relFiles, walkState)) return;
          } else {
            relFiles.push(relative(dir.rootReal, full));
          }
        }
        if (!gitIndexMatches(dir.rootReal, relFiles)) return;
        stepRoots.push('worktree (Git-tracked files)');
        flags.push('git_tracked_only');
      } else {
        stepRoots.push(dir.category);
      }
      canonicals.push(join(dir.canonical, pattern));
      continue;
    }

    const target = resolveTargetPath(raw, activeCwd, roots, { mode: 'delete', allowRootItself: false });
    if (!target || target.isSymlink) return;
    if (target.usedCwd) flags.push('verified_cwd');
    if (target.category === 'worktree') {
      if (!target.exists) return;
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

function isSafeWriteTarget(target: ResolvedTarget): boolean {
  if (target.isSymlink) return false;
  if (!target.exists) return true;
  if (!target.isFile || !target.singleLink) return false;
  if (target.category === 'scratchpad' || target.category === 'task scratchpad') {
    return true;
  }
  if (target.category === 'worktree') {
    return gitIndexMatches(target.rootReal, [target.rel]);
  }
  return false;
}

function validateCpMv(verb: 'cp' | 'mv', args: string[], activeCwd: string | undefined, roots: ResolvedRoots): StepInternal | undefined {
  let afterDash = false;
  let force = false;
  let noTargetDir = false;
  let targetDir: string | undefined;
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!afterDash && arg === '--') { afterDash = true; continue; }
    if (!afterDash && arg.startsWith('-')) {
      if (arg === '-t' && i + 1 < args.length) { targetDir = args[++i]; continue; }
      if (arg.startsWith('--target-directory=')) { targetDir = arg.slice('--target-directory='.length); continue; }
      if (arg === '--no-target-directory') { noTargetDir = true; continue; }
      if (arg === '--force') { force = true; continue; }
      if (['--no-clobber', '--verbose'].includes(arg)) continue;
      if (isShortFlagBundle(arg, 'fnvuT')) {
        if (arg.includes('f')) force = true;
        if (arg.includes('T')) noTargetDir = true;
        continue;
      }
      return;
    }
    paths.push(arg);
  }
  if (targetDir && noTargetDir) return;
  const sources = targetDir ? paths : paths.slice(0, -1);
  const dest = targetDir ?? paths.at(-1);
  if (!sources.length || !dest) return;

  const stepRoots: PermissionRootCategory[] = [];
  const flags: PermissionFlag[] = [];
  const canonicals: string[] = [];
  const childNames = new Set<string>();
  if (force) flags.push('force');

  for (const src of sources) {
    const r = resolveTargetPath(src, activeCwd, roots, { mode: verb === 'mv' ? 'write' : 'read' });
    // Only regular source entries: a symlink's referent is not the entry the utility names or moves.
    const name = basename(src);
    if (!r?.isFile || !name || name === '.' || childNames.has(name)) return;
    if (r.usedCwd) flags.push('verified_cwd');
    childNames.add(name);
    stepRoots.push(r.category);
    canonicals.push(r.canonical);
  }
  const destResolved = resolveTargetPath(dest, activeCwd, roots, { mode: 'write', allowRootItself: true });
  if (!destResolved || destResolved.isSymlink) return;
  if (destResolved.usedCwd) flags.push('verified_cwd');

  const expectsDir = Boolean(targetDir) || childNames.size > 1 || dest.endsWith('/') || destResolved.isDir;
  if (noTargetDir && expectsDir) return;

  const recordWriteTarget = (target: ResolvedTarget) => {
    if (!isSafeWriteTarget(target)) return false;
    if (target.category === 'worktree' && target.exists) {
      stepRoots.push('worktree (Git-tracked files)');
      flags.push('git_tracked_only');
    } else {
      stepRoots.push(target.category);
    }
    canonicals.push(target.canonical);
    return true;
  };

  if (expectsDir) {
    if (destResolved.exists && !destResolved.isDir) return;
    for (const childName of childNames) {
      const child = resolveTargetPath(join(destResolved.canonical, childName), activeCwd, roots, {
        mode: 'write',
        allowRootItself: false,
      });
      if (!child || !recordWriteTarget(child)) return;
    }
  } else {
    if (!destResolved.rel || !recordWriteTarget(destResolved)) return;
  }
  return { kind: 'housekeeping', verb, roots: dedupe(stepRoots), flags: dedupe(flags), canonicals };
}

function validateLn(args: string[], activeCwd: string | undefined, roots: ResolvedRoots): StepInternal | undefined {
  let symbolic = false;
  let afterDash = false;
  const paths: string[] = [];
  for (const arg of args) {
    if (!afterDash && arg === '--') { afterDash = true; continue; }
    if (!afterDash && arg.startsWith('-')) {
      if (arg === '--symbolic') { symbolic = true; continue; }
      if (arg === '--no-dereference' || arg === '--verbose') continue;
      if (isShortFlagBundle(arg, 'snvT')) {
        if (arg.includes('s')) symbolic = true;
        continue;
      }
      return;
    }
    paths.push(arg);
  }
  if (!symbolic || paths.length !== 2) return;
  const [targetRaw, linkRaw] = paths;
  const link = resolveTargetPath(linkRaw, activeCwd, roots, { mode: 'write', allowRootItself: false });
  if (!link || link.exists || linkRaw.endsWith('/')) return;
  // Relative symlink targets resolve relative to the symlink's parent directory.
  const target = resolveTargetPath(targetRaw, activeCwd, roots, {
    mode: 'read',
    allowRootItself: true,
    cwdBase: dirname(link.canonical),
  });
  if (!target) return;
  const flags: PermissionFlag[] = ['symlink'];
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
  let afterDash = false;
  const positional: string[] = [];
  for (const arg of args) {
    if (!afterDash && arg === '--') { afterDash = true; continue; }
    if (!afterDash && arg.startsWith('-')) {
      if (['--verbose', '--changes', '--silent', '--quiet'].includes(arg) || isShortFlagBundle(arg, 'vcf')) continue;
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
  const flags: PermissionFlag[] = [];
  const canonicals: string[] = [];
  for (const p of paths) {
    const r = resolveTargetPath(p, activeCwd, roots, { mode: 'write', allowRootItself: false });
    if (!r || !(r.isDir || (r.isFile && r.singleLink))) return;
    if (r.usedCwd) flags.push('verified_cwd');
    stepRoots.push(r.category);
    canonicals.push(r.canonical);
  }
  return { kind: 'housekeeping', verb: 'chmod', roots: dedupe(stepRoots), flags: dedupe(flags), canonicals };
}

function validateTar(args: string[], activeCwd: string | undefined, roots: ResolvedRoots): StepInternal | undefined {
  let listOnly = false;
  let archive: string | undefined;
  let afterDash = false;
  const members: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!afterDash && arg === '--') { afterDash = true; continue; }
    if (!afterDash && arg.startsWith('-')) {
      if (arg === '--list') { listOnly = true; continue; }
      if (arg === '-f' || arg === '--file') { if (i + 1 >= args.length) return; archive = args[++i]; continue; }
      if (arg.startsWith('--file=')) { archive = arg.slice('--file='.length); continue; }
      if (['--gzip', '--bzip2', '--xz', '--verbose'].includes(arg)) continue;
      if (isShortFlagBundle(arg, 'tzfJjv')) {
        if (arg.includes('t')) listOnly = true;
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
  // Extraction without inspecting and proving every archive member goes to main.
  if (!listOnly || !archive || archive.includes(':')) return;
  for (const m of members) {
    if (isAbsolute(m) || m.split('/').includes('..') || isSensitiveRel(m)) return;
  }
  const arch = resolveTargetPath(archive, activeCwd, roots, { mode: 'read', allowRootItself: false });
  if (!arch) return;
  return {
    kind: 'read_only',
    verb: 'tar',
    roots: [arch.category],
    flags: arch.usedCwd ? ['verified_cwd'] : [],
    canonicals: [arch.canonical],
  };
}

function validateUnzip(args: string[], activeCwd: string | undefined, roots: ResolvedRoots): StepInternal | undefined {
  let listOnly = false;
  let afterDash = false;
  const positional: string[] = [];
  for (const arg of args) {
    if (!afterDash && arg === '--') { afterDash = true; continue; }
    if (!afterDash && arg.startsWith('-')) {
      if (isShortFlagBundle(arg, 'qlv')) {
        if (arg.includes('l')) listOnly = true;
        continue;
      }
      return;
    }
    positional.push(arg);
  }
  // Extraction without inspecting and proving every archive member goes to main.
  if (!listOnly || !positional.length) return;
  const [archive, ...members] = positional;
  for (const m of members) {
    if (isAbsolute(m) || m.split('/').includes('..') || isSensitiveRel(m)) return;
  }
  const arch = resolveTargetPath(archive, activeCwd, roots, { mode: 'read', allowRootItself: false });
  if (!arch) return;
  return {
    kind: 'read_only',
    verb: 'unzip',
    roots: [arch.category],
    flags: arch.usedCwd ? ['verified_cwd'] : [],
    canonicals: [arch.canonical],
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
        if (isShortFlagBundle(arg, 'aAlh1trSdFnis') || ['--all', '--almost-all', '--human-readable', '--reverse', '--directory'].includes(arg) || /^--color(?:=\w+)?$/.test(arg)) continue;
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
        if (isShortFlagBundle(arg, 'ucNqsiwbB') || ['--unified', '--brief'].includes(arg) || /^--color(?:=\w+)?$/.test(arg) || /^-U\d+$/.test(arg)) continue;
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
    const r = resolveTargetPath(p, activeCwd, roots, { mode: 'read', allowRootItself: verb === 'ls' });
    if (!r || (verb === 'diff' && !r.isFile)) return;
    if (r.usedCwd) flags.push('verified_cwd');
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
      if (['--ignore-case', '--invert-match', '--line-number', '--count', '--files-with-matches',
        '--only-matching', '--word-regexp', '--fixed-strings', '--quiet', '--with-filename', '--no-filename'].includes(arg)) continue;
      if (verb === 'rg' && ['--smart-case', '--no-heading'].includes(arg)) continue;
      if (verb === 'grep' && ['--files-without-match', '--extended-regexp'].includes(arg)) continue;
      if (isShortFlagBundle(arg, verb === 'rg' ? 'ivnclHowxFqsS' : 'ivnclLhowxFEqsa')) continue;
      return;
    }
    positional.push(arg);
  }
  if (!hasExplicitPattern && !positional.length) return;
  const paths = hasExplicitPattern ? positional : positional.slice(1);
  const stepRoots: PermissionRootCategory[] = [];
  const flags: PermissionFlag[] = [];
  const canonicals: string[] = [];
  if (!paths.length && !hasStdin) return;
  for (const p of paths) {
    const r = resolveTargetPath(p, activeCwd, roots, { mode: 'read' });
    if (!r?.isFile) return;
    if (r.usedCwd) flags.push('verified_cwd');
    stepRoots.push(r.category);
    canonicals.push(r.canonical);
  }
  return { kind: 'read_only', verb, roots: dedupe(stepRoots), flags: dedupe(flags), canonicals };
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
    if (!resolved || !isSafeWriteTarget(resolved)) return;
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
  const activeCwd = roots.verifiedCwd;
  const operations: PermissionStepProof[] = [];
  const allCanonicals: string[] = [];

  // No shell state to carry across commands. Recognize just the two-command scratchpad rm idiom.
  const [first, second] = parsed;
  const literalScratch = first.tokens.length === 1 && !first.tokens[0].quoted
    ? /^S=(\/[A-Za-z0-9_./+-]*)$/.exec(first.tokens[0].value)?.[1] : undefined;
  let scratch: ResolvedTarget | undefined;
  if (literalScratch) {
    if (parsed.length !== 2 || second.sepBefore !== 'seq' || first.redirs.length || second.redirs.length ||
        second.tokens[0].value !== 'rm' || second.tokens[0].quoted) return;
    scratch = resolveTargetPath(literalScratch, undefined, roots, { mode: 'read', allowRootItself: true });
    if (!scratch?.isDir || scratch.rel || !['scratchpad', 'task scratchpad'].includes(scratch.category)) return;
    parsed.shift();
  }

  for (const [i, cmd] of parsed.entries()) {
    const [verb, ...args] = cmd.tokens.map(token => token.value);
    const executable = trustedExecutable(verb, roots.path);
    if (!executable) return;
    for (let a = 0; a < args.length; a++) {
      const arg = args[a];
      if (scratch && arg.startsWith(`${SCRATCH_VAR}/`) && !arg.slice(SCRATCH_VAR.length).includes('\0')) {
        args[a] = literalScratch! + arg.slice(SCRATCH_VAR.length);
      } else if (arg.includes('\0') || (scratch && !arg.startsWith('-'))) return;
    }
    // Only rm path operands use shell globs. Quoted patterns in grep/rg/find are tool arguments, not shell globs.
    if (cmd.tokens.some(t => globChars.test(t.value) && (verb === 'rm' ? t.quoted : !t.quoted))) return;
    if (cmd.pipedFromPrev && !READ_ONLY_PIPE_SINKS.has(verb)) return;

    // Validate redirections for this simple command.
    const redirRoots: PermissionRootCategory[] = [];
    const redirFlags: PermissionFlag[] = [];
    const redirCanonicals: string[] = [];
    let hasStdinRedir = false;
    let writesFile = false;
    for (const redir of cmd.redirs) {
      const target = redir.target;
      if (!target || target.includes('\0')) return;
      if (target === '/dev/null') {
        redirFlags.push(redir.mode === 'read' ? 'redirect_read' : 'redirect_write');
        if (redir.mode === 'read') hasStdinRedir = true;
        continue;
      }
      const resolved = resolveTargetPath(target, activeCwd, roots, { mode: redir.mode, allowRootItself: false });
      if (!resolved) return;
      if (redir.mode === 'write') {
        if (writesFile || !isSafeWriteTarget(resolved)) return;
        writesFile = true;
      }
      redirRoots.push(resolved.category);
      redirFlags.push(redir.mode === 'read' ? 'redirect_read' : 'redirect_write');
      if (resolved.usedCwd) redirFlags.push('verified_cwd');
      if (redir.mode === 'read') hasStdinRedir = true;
      redirCanonicals.push(resolved.canonical);
    }

    const hasStdin = cmd.pipedFromPrev || hasStdinRedir;
    let step: StepInternal | undefined;
    switch (verb) {
      case 'rm': step = validateRm(args, scratch ? undefined : activeCwd, roots); break;
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
      default: return;
    }
    if (!step || (writesFile && step.kind !== 'read_only')) return;
    if (scratch && step.canonicals.some(target => !inside(scratch.canonical, target))) return;
    // Every proof sees the pre-command filesystem. Mutations must be terminal and never concurrent in a pipe.
    if ((writesFile || step.kind !== 'read_only') && (i !== parsed.length - 1 || cmd.pipedFromPrev)) return;
    const stepRoots = dedupe([...step.roots, ...redirRoots]);
    const stepFlags = dedupe([...step.flags, ...redirFlags, ...(cmd.pipedFromPrev ? (['pipe'] as const) : [])]);
    operations.push({ kind: step.kind, verb: step.verb, roots: stepRoots, flags: stepFlags });
    allCanonicals.push(executable, ...step.canonicals, ...redirCanonicals);
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
  const resolved = resolveRoots(typeof target === 'string' ? roots : {
    ...roots, cwd: target.kind === 'shell' ? target.cwd ?? roots.cwd : target.cwd,
  });
  if (!resolved.ordered.length) return;
  if (typeof target === 'string') return proveShellPrompt(target, resolved);
  return target.kind === 'shell' ? proveShellPrompt(target.command, resolved) : proveFilePrompt(target, resolved);
}

const reasons = {
  approve: 'The locally verified operation stays inside the job’s own roots and involves no Git commands, network writes, secrets or installation.',
  outside: 'The operation is not proven to stay inside this job’s roots.',
  irreversible: 'The operation is not proven reversible or regenerable.',
  restricted: 'The operation may involve Git commands, network writes, secrets or installation.',
  unsure: 'HUD could not prove that this operation is low risk.',
} as const;
const choices = Object.keys(reasons) as (keyof typeof reasons)[];

/** Only structural evidence leaves the machine: never send command arguments, environment or absolute paths. */
export async function classifyPermission(
  home: string,
  proof: PermissionProof | undefined,
  decide = dispatchDecision,
): Promise<PermissionDecision> {
  const fallback: PermissionDecision = proof
    ? { action: 'approve', reason: `Local path check: verified ${proof.summary}.` }
    : { action: 'main', reason: reasons.unsure };
  try {
    const { result } = await decide(home, loadSettings({ ...process.env, HUD_HOME: home }), 'worker-permission', {
      page: { url: '', title: 'Worker permission prompt', text: '' }, elements: [], statements: [], deltas: {},
      facts: proof
        ? {
            verified: true,
            operations: proof.operations.map(op => ({
              kind: op.kind,
              verb: op.verb,
              roots: op.roots,
              flags: op.flags,
            })),
            roots: proof.roots,
          }
        : { verified: false, operations: [], roots: [] },
      choices: [{
        name: 'permission',
        statement: 'Classify a native worker permission prompt from the quoted structural facts only. Approve only when verified is true and every operation is a locally proven low-risk file edit, file housekeeping or read-only inspection confined to the job’s own worktree, task directory or derived scratchpad, with no Git commands, network write, secrets, installs, privilege escalation or paths outside the job’s roots. If anything is missing or uncertain, hand to main and choose the best reason. Never deny.',
        choices: choices.map(value => ({ value, description: reasons[value] })),
      }],
    });
    const reason = result && dispatchChoice(result, 'permission', choices);
    if (reason && reason !== 'approve') return { action: 'main', reason: `Decision model: ${reasons[reason]}` };
    if (reason === 'approve' && proof) {
      return { action: 'approve', reason: `Decision model and local path check: verified ${proof.summary}.` };
    }
  } catch { /* Missing credentials, invalid output or timeout: local proof only. */ }
  return fallback;
}
