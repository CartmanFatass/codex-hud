/**
 * Read-only role backstop, NOT a security sandbox. Shell/test/interpreter effects
 * cannot be inferred reliably. QA files and scratch files are inherited exceptions,
 * never permission to edit the worktree. No shell-based report-write exception.
 */
import * as fs from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { DispatchRole } from '../pi-dispatch.js';
export interface GuardContext {
  role: DispatchRole;
  cwd: string;
  allowedWritePaths: readonly string[];
  qaDirectory: string;
  temporaryDirectory: string;
}
export type GuardResult = { allowed: true } | { allowed: false; reason: string };
const ALLOW: GuardResult = { allowed: true };
function denied(reason: string): GuardResult {
  return { allowed: false, reason };
}
function inside(path: string, directory: string): boolean {
  return path.startsWith(directory + '/');
}
function noLinks(path: string): boolean {
  for (let cursor = path; ; cursor = dirname(cursor)) {
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    if (dirname(cursor) === cursor) return true;
  }
}
const GIT_MUTATIONS = new Set([
  'commit',
  'push',
  'checkout',
  'switch',
  'reset',
  'clean',
  'apply',
  'rebase',
  'merge',
  'cherry-pick',
  'revert',
  'am',
  'add',
  'rm',
  'mv',
  'restore',
  'pull',
  'init',
  'clone',
  'notes',
  'update-ref',
  'symbolic-ref',
]);
function gitMutation(command: string): boolean {
  for (const match of command.matchAll(/\bgit\s+([^;\n|&]*)/g)) {
    const words = match[1]!.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g) ?? [];
    let index = 0;
    while (words[index]?.startsWith('-')) {
      const option = words[index++]!;
      if (['-C', '-c', '--git-dir', '--work-tree'].includes(option)) index++;
    }
    const subcommand = words[index++]?.replace(/["']+$/g, '');
    const rest = words.slice(index).map((word) => word.replace(/["']+$/g, ''));
    if (!subcommand) continue;
    if (GIT_MUTATIONS.has(subcommand)) return true;
    if (subcommand === 'stash' && !['list', 'show'].includes(rest[0] ?? '')) return true;
    if (subcommand === 'reflog' && ['expire', 'delete', 'drop', 'write'].includes(rest[0] ?? '')) return true;
    if (
      subcommand === 'branch' &&
      rest.some((word) =>
        /^(?:-[dDmMcCf]|--(?:delete|move|copy|force|edit-description|set-upstream-to|unset-upstream))(?:$|=)/.test(word)
      )
    )
      return true;
    if (
      subcommand === 'tag' &&
      rest.some((word) => /^(?:-[dasmf]|--(?:delete|annotate|sign|message|force))(?:$|=)/.test(word))
    )
      return true;
    if (
      subcommand === 'config' &&
      !rest.some((word) =>
        ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', 'get', 'list'].includes(word)
      )
    )
      return true;
    if (
      subcommand === 'branch' &&
      rest.length &&
      !rest.some((word) =>
        ['--list', '-l', '--show-current', '--contains', '--no-contains', '--merged', '--no-merged'].includes(word)
      )
    )
      return true;
    if (
      subcommand === 'tag' &&
      rest.length &&
      !rest.some((word) => ['--list', '-l', '--contains', '--merged'].includes(word))
    )
      return true;
    if (subcommand === 'worktree' && rest[0] !== 'list') return true;
    if (subcommand === 'submodule' && rest.length && !['status', 'summary'].includes(rest[0]!)) return true;
  }
  return false;
}
/** Only simple shell permits quoted redirect characters to be treated as data. */
function redirectView(command: string): string {
  if (/[\n`]|\$\(|\$\{|\$['"]|<</.test(command) || /(?:^|[\s;|&])case(?:\s|$)/.test(command)) return command;
  let view = '';
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === '\\') {
      view += 'xx';
      i++;
      continue;
    }
    if (ch !== "'" && ch !== '"') {
      view += ch;
      continue;
    }
    let end = i + 1;
    for (; end < command.length; end++) {
      if (ch === '"' && command[end] === '\\') {
        end++;
        continue;
      }
      if (command[end] === ch) break;
    }
    if (end === command.length) {
      view += command.slice(i);
      break;
    }
    const content = command.slice(i + 1, end);
    view += content === '/dev/null' ? '/dev/null' : 'x';
    i = end;
  }
  return view;
}
const FILE_MUTATIONS = new Set([
  'rm',
  'rmdir',
  'mv',
  'cp',
  'install',
  'ln',
  'mkdir',
  'touch',
  'truncate',
  'dd',
  'tee',
  'chmod',
  'chown',
  'chgrp',
  'shred',
  'rsync',
  'unlink',
  'patch',
]);
/** Tokenize only the prefix we inspect; this is not a shell parser or sandbox. */
function commandWords(command: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote = '';
  let started = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (char === '\\' && quote !== "'" && i + 1 < command.length) {
      started = true;
      word += command[++i];
    } else if (quote) {
      if (char === quote) quote = '';
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        words.push(word);
        word = '';
        started = false;
      }
    } else {
      word += char;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}
const XARGS_VALUE_OPTIONS = new Set([
  '-I',
  '-E',
  '-L',
  '-n',
  '-P',
  '-d',
  '--replace',
  '--eof',
  '--max-lines',
  '--max-args',
  '--max-procs',
  '--delimiter',
]);
function commandParts(command: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote = '';
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (char === '\\' && quote !== "'") {
      i++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (/[;|&\n(]/.test(char)) {
      parts.push(command.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(command.slice(start));
  return parts;
}
function fileMutation(command: string): boolean {
  // Normal prefixes preserve quoted separators in assignment/option values.
  // The second pass retains inherited conservative refusals inside quoted data.
  for (const part of [...commandParts(command), ...command.split(/[;|&\n(]/)]) {
    const words = commandWords(part);
    let i = 0;
    while (i < words.length) {
      const word = words[i]!;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || word === 'env' || word === 'sudo') {
        i++;
        continue;
      }
      if (word === 'xargs') {
        i++;
        while (words[i]?.startsWith('-')) {
          const option = words[i++]!;
          if (option === '--') break;
          if (XARGS_VALUE_OPTIONS.has(option)) i++;
        }
        continue;
      }
      if (FILE_MUTATIONS.has(word)) return true;
      break;
    }
  }
  return false;
}
export function guardShell(command: string): GuardResult {
  const raw = command.replace(/\\\n/g, ' ');
  if (gitMutation(raw)) return denied('git_mutation');
  if (/\b(?:sed|perl|ruby)\b[^;\n|&]*\s-[A-Za-z]*i/.test(raw)) return denied('in_place_edit');
  if (fileMutation(raw)) return denied('file_mutation');
  if (
    /\b(?:npm|pnpm|yarn|bun|pip|pip3|uv|brew|apt|apt-get|pacman|dnf|yum|cargo|gem)\s+(?:install|i|add|remove|uninstall|update|upgrade)\b/.test(
      raw
    )
  )
    return denied('installer');
  const redirects = redirectView(raw)
    .replace(/\d*>\s*&[0-9-]+\b/g, '')
    .replace(/(?:\d*|&)>>?\s*\/dev\/null(?=\s|$|[;&|])/g, '');
  if (redirects.includes('>')) return denied('redirect');
  return ALLOW;
}
export function guardTool(context: GuardContext, tool: string, input: Record<string, unknown>): GuardResult {
  if (context.role !== 'reviewer' && context.role !== 'architect') return ALLOW;
  if (tool === 'edit') return denied('read_only_role');
  if (tool === 'bash') return typeof input.command === 'string' ? guardShell(input.command) : denied('invalid_command');
  if (tool !== 'write') return ALLOW;
  if (typeof input.path !== 'string' || /[\0\r\n]/.test(input.path)) return denied('unauthorized_write');
  const path = resolve(context.cwd, input.path);
  const authorized =
    context.allowedWritePaths.some((allowed) => isAbsolute(allowed) && path === allowed) ||
    inside(path, context.qaDirectory) ||
    inside(path, context.temporaryDirectory);
  return authorized && noLinks(path) ? ALLOW : denied('unauthorized_write');
}
