import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export interface GitChangedFile {
  path: string;
  previousPath?: string;
  index: string;
  worktree: string;
  added: number | null;
  removed: number | null;
  binary: boolean;
  conflict: boolean;
}

export interface GitChanges {
  root: string | null;
  branch: string | null;
  ahead: number;
  behind: number;
  files: GitChangedFile[];
  error?: string;
}

const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 64 * 1024;
const MAX_PREVIEW_LINES = 500;

function git(cwd: string, args: string[], preview = false): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'color.ui=false',
      '-c', 'core.quotePath=true', ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: preview ? MAX_PREVIEW_BYTES : MAX_OUTPUT,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_LITERAL_PATHSPECS: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_NO_LAZY_FETCH: '1',
      },
    }, (error, stdout) => {
      if (error) {
        if (preview && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && stdout) {
          resolveOutput(`${stdout}\n[Preview truncated]`);
        } else {
          reject(error);
        }
      } else {
        resolveOutput(stdout);
      }
    });
  });
}

function safeText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,
    character => `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

type ExecFailure = Error & {
  code?: string | number;
  syscall?: string;
  killed?: boolean;
  stderr?: string;
  stdout?: string;
};

function execFailureText(error: unknown): string {
  const err = error as ExecFailure;
  return [err?.stderr, err?.stdout, error instanceof Error ? error.message : String(error)]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join('\n');
}

function isNotAGitRepository(error: unknown): boolean {
  return /not a git repository/i.test(execFailureText(error));
}

/** User-facing Git failure. Never the spawned argv, Node code, or raw Git stderr. */
export function describeGitFailure(error: unknown): string {
  const err = error as ExecFailure;
  const text = execFailureText(error);
  // A path deleted since the status read is missing too, but git is not.
  if (err?.code === 'ENOENT' && err.syscall && !err.syscall.startsWith('spawn')) return 'No longer on disk';
  if (err?.code === 'ENOENT') return 'Git is not installed';
  if (err?.code === 'ETIMEDOUT' || err?.killed) return 'Git timed out';
  if (err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'Git output was truncated';
  if (/Cannot safely disable configured Git filter/i.test(text)) return 'Git filters could not be disabled safely';
  if (isNotAGitRepository(error)) return 'No Git repository';
  if (/permission denied|eacces|eperm/i.test(text)) return 'Git could not read the repository';
  if (/index\.lock|unable to create .*\.lock/i.test(text)) return 'Git is locked by another process';
  if (/bad object|missing blob|missing object|unable to read [0-9a-f]{4,}|unable to read tree|could not read/i.test(text)) {
    return 'Git objects are missing';
  }
  if (/corrupt|broken repository/i.test(text)) return 'Git repository is damaged';
  return 'Git could not complete the request';
}

const DIFF_OPTIONS = ['--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '--ignore-submodules=all'];

async function filterOverrides(cwd: string): Promise<string[]> {
  let output: string;
  try {
    // Config discovery does not inspect worktree content or invoke filter drivers.
    // Name-only, NUL-delimited output also handles multiline command values safely.
    output = await git(cwd, ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process|required)$']);
  } catch (error) {
    if ((error as { code?: number }).code === 1) return []; // No matching configuration.
    throw error;
  }
  const names = new Set<string>();
  for (const key of output.split('\0')) {
    if (!key) continue;
    const match = /^filter\.([\s\S]+)\.(?:clean|process|required)$/.exec(key);
    // An equals sign cannot be represented unambiguously by Git's -c key=value syntax.
    if (!match || match[1].includes('=')) throw new Error('Cannot safely disable configured Git filter');
    names.add(match[1]);
  }
  return [...names].flatMap(name => [
    '-c', `filter.${name}.clean=`, '-c', `filter.${name}.process=`, '-c', `filter.${name}.required=false`,
  ]);
}

function addNumstat(output: string, files: Map<string, GitChangedFile>): void {
  const records = output.split('\0');
  for (let i = 0; i < records.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(records[i]);
    if (!match) continue;
    let path = match[3];
    if (!path) {
      // With -z a rename has an empty path, then separate old and new paths.
      i++;
      path = records[++i];
    }
    const file = files.get(path);
    if (!file || file.conflict) continue;
    if (match[1] === '-' || match[2] === '-') {
      file.binary = true;
      file.added = null;
      file.removed = null;
    } else if (!file.binary) {
      file.added = (file.added ?? 0) + Number(match[1]);
      file.removed = (file.removed ?? 0) + Number(match[2]);
    }
  }
}

export async function collectGitChanges(cwd: string): Promise<GitChanges> {
  const result: GitChanges = { root: null, branch: null, ahead: 0, behind: 0, files: [] };
  try {
    result.root = (await git(cwd, ['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, '');
    const overrides = await filterOverrides(result.root);
    // An untracked directory is one entry, "out/", as `git status` lists it:
    // thousands of generated files one by one would bury the edits. What is
    // in it is the Inspector's to list.
    const output = await git(result.root, [...overrides, '-c', 'status.renames=true', 'status', '--porcelain=v2',
      '--branch', '-z', '--untracked-files=normal', '--ignore-submodules=all']);
    const records = output.split('\0');
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (record.startsWith('# branch.head ')) {
        const branch = record.slice(14);
        result.branch = branch === '(detached)' ? null : branch;
      } else if (record.startsWith('# branch.ab ')) {
        const counts = /^# branch.ab \+(\d+) -(\d+)$/.exec(record);
        if (counts) {
          result.ahead = Number(counts[1]);
          result.behind = Number(counts[2]);
        }
      } else if (/^[12u?] /.test(record)) {
        const kind = record[0];
        // Only metadata is space-delimited; the remaining bytes are the literal path.
        const fields = kind === '?' ? 1 : kind === '1' ? 8 : kind === '2' ? 9 : 10;
        let start = 0;
        for (let field = 0; field < fields; field++) start = record.indexOf(' ', start) + 1;
        const xy = kind === '?' ? '??' : record.slice(2, 4);
        const file: GitChangedFile = {
          path: record.slice(start),
          index: xy[0] === '.' ? ' ' : xy[0],
          worktree: xy[1] === '.' ? ' ' : xy[1],
          added: kind === '?' || kind === 'u' ? null : 0,
          removed: kind === '?' || kind === 'u' ? null : 0,
          binary: false,
          conflict: kind === 'u',
        };
        if (kind === '2') file.previousPath = records[++i];
        result.files.push(file);
      }
    }
    const files = new Map(result.files.map(file => [file.path, file]));
    const stats = await Promise.allSettled([
      git(result.root, [...overrides, 'diff', ...DIFF_OPTIONS, '--numstat', '-z', '--cached']),
      git(result.root, [...overrides, 'diff', ...DIFF_OPTIONS, '--numstat', '-z']),
    ]);
    for (const stat of stats) {
      if (stat.status === 'fulfilled') addNumstat(stat.value, files);
      else result.error = describeGitFailure(stat.reason);
    }
    if (stats.some(stat => stat.status === 'rejected')) {
      // A partial result must not present missing-object or timeout failures as zero changes.
      for (const file of result.files) {
        file.added = null;
        file.removed = null;
      }
    }
  } catch (error) {
    // A workspace without Git is not a collector failure; keep root empty and do not
    // surface the failed rev-parse command as the HUD message.
    if (!isNotAGitRepository(error)) result.error = describeGitFailure(error);
  }
  return result;
}

function contained(root: string, path: string): boolean {
  const local = relative(root, path);
  return local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

async function untrackedPreview(root: string, path: string): Promise<string> {
  const fullPath = resolve(root, path);
  const actualRoot = await realpath(root);
  const actualParent = await realpath(dirname(fullPath));
  if (!contained(actualRoot, actualParent)) return '[Preview unavailable: path leaves repository]';
  const info = await lstat(fullPath);
  if (info.isSymbolicLink()) return `Symlink → ${await readlink(fullPath)}`;
  if (!info.isFile()) return '[Preview unavailable: not a regular file]';
  const handle = await open(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) return '[Preview unavailable: not a regular file]';
    const buffer = Buffer.alloc(MAX_PREVIEW_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const content = buffer.subarray(0, Math.min(bytesRead, MAX_PREVIEW_BYTES));
    if (content.includes(0)) return '[Binary file: preview unavailable]';
    return content.toString('utf8') + (bytesRead > MAX_PREVIEW_BYTES ? '\n[Preview truncated]' : '');
  } finally {
    await handle.close();
  }
}

/**
 * What an untracked directory holds: how many files, then each one's path
 * inside it, as `git status --untracked-files=all` would list them. A
 * repository of its own lists as itself, and git does not look inside it.
 */
async function untrackedListing(root: string, path: string): Promise<string> {
  if (!contained(await realpath(root), await realpath(resolve(root, path)))) return '[Preview unavailable: path leaves repository]';
  const listed = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', path])).split('\0').filter(Boolean);
  const files = listed.filter(file => file !== path && file.startsWith(path)).map(file => file.slice(path.length));
  if (!files.length && listed.length) return '[Preview unavailable: a repository of its own]';
  return [`${files.length} ${files.length === 1 ? 'file' : 'files'}`, ...files].join('\n');
}

/**
 * The hunks of the whole uncommitted diff, staged and unstaged, with one line
 * of context and capped, for the change summary. Untracked files are not
 * read: their names are in the stat.
 */
export async function readDiffHunks(root: string): Promise<string> {
  const overrides = await filterOverrides(root);
  const [staged, unstaged] = await Promise.all([
    git(root, [...overrides, 'diff', ...DIFF_OPTIONS, '--unified=1', '--cached'], true),
    git(root, [...overrides, 'diff', ...DIFF_OPTIONS, '--unified=1'], true),
  ]);
  return safeText([staged.trim() && `Staged\n${staged}`, unstaged.trim() && `Unstaged\n${unstaged}`].filter(Boolean).join('\n'));
}

export async function readGitDiff(root: string, file: GitChangedFile): Promise<string[]> {
  const paths = file.previousPath ? [file.path, file.previousPath] : [file.path];
  if (paths.some(path => !path || isAbsolute(path) || !contained(resolve(root), resolve(root, path)))) {
    return ['[Preview unavailable: invalid repository path]'];
  }
  const sections: string[] = [];
  try {
    if (file.index === '?' && file.worktree === '?') {
      // Only an untracked directory ends in a slash: git lists its files, never its contents.
      const preview = file.path.endsWith('/') ? untrackedListing(root, file.path) : untrackedPreview(root, file.path);
      sections.push(`Untracked\n${await preview}`);
    } else {
      const overrides = await filterOverrides(root);
      if (file.index !== ' ' && file.index !== '.') {
        sections.push(`Staged\n${await git(root, [...overrides, 'diff', ...DIFF_OPTIONS, '--cached', '--', ...paths], true)}`);
      }
      if (file.worktree !== ' ' && file.worktree !== '.') {
        sections.push(`Unstaged\n${await git(root, [...overrides, 'diff', ...DIFF_OPTIONS, '--', ...paths], true)}`);
      }
    }
  } catch (error) {
    sections.push(`[Preview unavailable: ${describeGitFailure(error)}]`);
  }
  // Reserve room for every section so a large staged patch cannot hide worktree edits.
  const budget = Math.floor(MAX_PREVIEW_LINES / Math.max(1, sections.length));
  return sections.flatMap(section => {
    const lines = safeText(section).split('\n').map(line =>
      line.length > 2000 ? `${line.slice(0, 2000)} [Line truncated]` : line);
    return lines.length > budget ? [...lines.slice(0, budget - 1), '[Preview truncated]'] : lines;
  });
}
