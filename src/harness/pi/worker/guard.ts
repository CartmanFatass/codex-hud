/** Port of the pi-roles read-only tool backstop. Bash checks are heuristics, not a sandbox for scripts or MCP. */
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { GuardMode } from '../../../roles/pi-defaults.js';
import type { WorkerPi } from './host.js';

const GIT_MUTATING =
	/\bgit\b(?:\s+(?:-C\s+(?:'[^']*'|"[^"]*"|\S+)|-c\s+\S+|--git-dir=\S+|--work-tree=\S+))*\s+(commit|push|checkout|switch|reset|stash(?!\s+(list|show)\b)|clean|apply|rebase|merge|cherry-pick|revert|am|add|rm|mv|restore|pull|init|clone|notes|update-ref|symbolic-ref|reflog\s+(expire|delete)|branch\s+(-[dDmMcC]|--delete|--move|--copy|--force|[^-\s]\S*)|tag\s+(-[dfa]|--delete|--force|[^-\s]\S*)|worktree\s+(add|remove|prune|move|lock|unlock)|submodule\s+(add|update|deinit|sync)|config(?!\s+(--get|--list|-l|--show-origin|--get-regexp|--get-all))|fetch(?![^;|&\n]*\s--dry-run\b))\b/;
const fileCommands = 'rm|rmdir|mv|cp|install|ln|mkdir|touch|truncate|dd|tee|chmod|chown|chgrp|shred|rsync|unlink|patch';
const FILE_MUTATING = new RegExp(`(^\\s*|[;&|(\\n]\\s*|\\b(?:sudo|command)\\s+|\\benv\\s+(?:\\w+=\\S*\\s+)*|\\bxargs\\s+(?:-\\S+\\s+)*)(?:[\\w./-]+/)?(${fileCommands})\\b`);
const INPLACE_EDIT = /\b(sed|perl|ruby)\b[^|;&]*\s(?:-[a-zA-Z]*i\S*|--in-place(?:=\S*)?)(?=\s|$)/;
const INSTALLERS =
	/\b(?:npm\s+ci|uv\s+(?:pip|tool)\s+install|(?:npm|pnpm|yarn|bun|pip|pip3|uv|cargo|gem|apt|apt-get|brew|pacman|dnf|yum)\s+(?:install|add|remove|uninstall|update|upgrade|i))\b/;
const REDIRECT = /(^|[^0-9&<>])>{1,2}(?!&)\s*(?!\/dev\/null\b)(\S)/;
const CLOBBER_REDIRECT = /(^|\s)&>|\d>\s*(?!&|\/dev\/null\b)\S/;

// Complex shell syntax retains the old, conservative raw redirect checks.
const COMPLEX_SHELL = /\$\(|`|\$\{|\$['"]|<<|(?:^|[\s;&|()])case(?=$|[\s;&|()])/;

// A quoted-delimiter heredoc body is literal stdin. It is dropped unless a shell may read it as commands.
const LITERAL_HEREDOC = /(?<!<)<<(-?)[ \t]*(?:'([A-Za-z_][\w.-]*)'|"([A-Za-z_][\w.-]*)"|\\([A-Za-z_][\w.-]*))/g;
const SHELL_READER = /(?:^|[\s;&|(/])(?:bash|sh|zsh|dash|ksh|fish|eval|source|xargs|ssh|su|sudo|exec|parallel)(?=$|[\s;&|)])/;

function dropLiteralHeredocs(command: string): string {
	const lines = command.split("\n");
	const kept: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		kept.push(line);
		const heredocs = [...line.matchAll(LITERAL_HEREDOC)];
		if (!heredocs.length) continue;
		// An unquoted heredoc on the same line, or a shell that may run the body: keep everything.
		if (/(?<!<)<<(?!<)/.test(line.replace(LITERAL_HEREDOC, "")) || SHELL_READER.test(line)) return command;
		for (const [, tabs, ...names] of heredocs) {
			const delimiter = names.find((name) => name !== undefined);
			let end = i + 1;
			while (end < lines.length && (tabs ? lines[end].replace(/^\t+/, "") : lines[end]) !== delimiter) end++;
			if (end >= lines.length) return command; // Unterminated: nothing is known to be data.
			i = end;
		}
	}
	return kept.join("\n");
}

/**
 * Hide quoted data (only single-quoted with `singleOnly`) in simple commands without expansions. A comment runs to its
 * line end and quotes in it are text.
 */
function maskQuotedText(command: string, singleOnly = false): string {
	const masked = command.split("");
	let wordStart = true;
	for (let i = 0; i < command.length;) {
		const quote = command[i];
		if (quote === "#" && wordStart) {
			while (i < command.length && command[i] !== "\n") i++;
		} else if (quote === "\\") {
			i += 2;
			wordStart = false;
		} else if (quote === "'" || quote === '"') {
			wordStart = false;
			const start = i++;
			while (i < command.length && command[i] !== quote) {
				if (quote === '"' && command[i] === "\\") i += 2;
				else i++;
			}
			// An incomplete quote must not hide any of the remaining command.
			if (i >= command.length) break;
			i++;
			// Non-whitespace placeholders keep quoted redirect targets detectable.
			if (quote === "'" || !singleOnly) masked.fill("x", start, i);
		} else {
			wordStart = /[\s;&|()<>]/.test(quote);
			i++;
		}
	}
	return masked.join("");
}

/** Why a shell command is not read-only, or undefined when it looks read-only. */
export function bashViolation(raw: string, scratch?: (path: string) => boolean): string | undefined {
	const command = dropLiteralHeredocs(raw);
	const cmd = command.replace(/\\\n/g, " ");
	if (GIT_MUTATING.test(cmd)) return 'git command that changes repository state';
	if (INPLACE_EDIT.test(cmd)) return 'in-place edit (sed/perl -i)';
	const changing = FILE_MUTATING.test(cmd);
	if (INSTALLERS.test(cmd)) return 'package installation';
	// Nothing expands inside single quotes, so expansions there (e.g. a script's template literal) are not complex.
	const complex = /\$['"]/.test(command) || COMPLEX_SHELL.test(maskQuotedText(command, true));
	const redirectCommand = complex ? command : maskQuotedText(command);
	const redirects = REDIRECT.test(redirectCommand) || CLOBBER_REDIRECT.test(redirectCommand);
	if ((changing || redirects) && scratch && !complex && scratchCommand(cmd, scratch)) return;
	if (changing) return 'file-changing command (rm/mv/cp/tee/chmod/...)';
	if (redirects) return 'output redirection to a file';
}

const fileCommand = new RegExp(`^(?:${fileCommands})$`);
const scratchFlags: Record<string, RegExp> = {
  cp: /^-[aRrp]+$/, mv: /^-[fn]+$/, mkdir: /^-p$/, rm: /^-[rf]+$/, rmdir: /^-p$/, tee: /^-a$/,
};

/** Recognize simple literal shell operands only. Ambiguous shell or unsupported writes fall back to strict mode. */
function scratchCommand(command: string, allowed: (path: string) => boolean) {
  const safe = (path: string) => isAbsolute(path) && allowed(path);
  const token = /[ \t]+|\n|&&|\|\||[;|]|(?:[0-9]|&)?>>?&?[0-9]?|'[^'\n]*'|"[^"\n$`\\]*"|[\w/.+,:=@%-]+/y;
  let words: string[] = [], foundWrite = false;
  const literal = (word: string) => word.replace(/^(['"])(.*)\1$/, '$2');
  function finish() {
    if (!words.length) return true;
    const segment = words.join(' '), [exe, ...args] = words.map(literal);
    words = [];
    const name = basename(exe!);
    if (!fileCommand.test(name)) return !FILE_MUTATING.test(segment);
    // No arbitrary options (e.g. `cp -t`) or commands with special write operands (e.g. `dd of=...`).
    const operands = args.filter(arg => !arg.startsWith('-'));
    if (!['cp', 'mv', 'mkdir', 'rm', 'rmdir', 'tee', 'touch', 'unlink'].includes(name) || !operands.length ||
        args.some(arg => arg.startsWith('-') && arg !== '--' && !scratchFlags[name]?.test(arg))) return false;
    foundWrite = true;
    if (name !== 'cp' && name !== 'mv') return operands.every(safe);
    const target = operands.at(-1)!, sources = operands.slice(0, -1);
    if (!sources.length || !safe(target) || (name === 'mv' && !sources.every(safe))) return false;
    // Copying/moving into a directory may overwrite an existing entry under a different path.
    try {
      return !statSync(target, { throwIfNoEntry: false })?.isDirectory() ||
        sources.every(path => safe(join(target, basename(path))));
    } catch { return false; }
  }
  for (let at = 0; at < command.length;) {
    token.lastIndex = at;
    const match = token.exec(command);
    if (!match) return false;
    const word = match[0];
    at = token.lastIndex;
    if (/^[ \t]+$/.test(word)) continue;
    if (/^[\n;|&]+$/.test(word)) { if (!finish()) return false; continue; }
    if (/^(?:[0-9]|&)?[>]/.test(word)) {
      if (/^[0-9]?>&[12]$/.test(word)) continue;
      foundWrite = true;
      token.lastIndex = at + (/^[ \t]*/.exec(command.slice(at))?.[0].length ?? 0);
      const target = literal(token.exec(command)?.[0] ?? '');
      if ((!safe(target) && target !== '/dev/null') || !/^[\s;|&>]|^$/.test(command.slice(token.lastIndex))) return false;
      at = token.lastIndex;
    } else {
      // Adjacent shell word fragments need a real parser, not a path exemption.
      if (!/^[\s;|&>]|^[0-9]>|^$/.test(command.slice(at))) return false;
      words.push(word);
    }
  }
  return finish() && foundWrite;
}

function within(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}

/** Resolve existing ancestors as well, since a write often creates its final path. */
function physicalPath(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A dangling symlink is not a missing destination we can safely create.
    if (lstatSync(path, { throwIfNoEntry: false })) throw error;
    return join(physicalPath(dirname(path)), basename(path));
  }
}

export function installGuard(pi: WorkerPi, mode: GuardMode, dir: string, projectRoot?: string) {
  const report = join(realpathSync(dir), 'report.md');
  pi.on('tool_call', ({ toolName, input }, { cwd }) => {
    const allowed = (path: string) => {
      if (!path || path.split('/').includes('..')) return false;
      try {
        const abs = resolve(cwd, path), dest = physicalPath(abs);
        const stat = statSync(dest, { throwIfNoEntry: false });
        if (stat?.isFile() && stat.nlink > 1) return false;
        if (dest === report && abs === resolve(dir, 'report.md')) return true;
        if (mode === 'strict' || [cwd, projectRoot].some(root => {
          if (!root) return false;
          const repo = physicalPath(root);
          return within(repo, dest) || within(dest, repo);
        })) return false;
        return [dirname(report), '/tmp', '/dev/shm'].some(root => dest !== root && within(root, dest));
      } catch { return false; }
    };
    const reason = toolName === 'edit' ? 'in-place edits are not allowed'
      : toolName === 'write' && !allowed(String(input.path ?? '').replace(/^@/, '')) ? 'write is outside the allowed paths'
      : toolName === 'bash' ? bashViolation(String(input.command ?? ''), mode === 'oracle' ? allowed : undefined) : undefined;
    if (reason) return { block: true, reason: `Read-only worker: ${reason}. Use hud_report to publish findings.${mode === 'oracle' ? ' Use literal scratch paths under /tmp, /dev/shm or the job directory.' : ''}` };
  });
}
