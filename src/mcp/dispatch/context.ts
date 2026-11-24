/** Dispatch argument and brief/context file handling. */
import * as fs from 'node:fs';
import { basename, resolve, relative, sep, isAbsolute, join } from 'node:path';
import { replyWords, needsTranslation } from '../../collectors/reply-language.js';
import { ownerPreferencesReference } from '../brief-prompt.js';
import type { StandingBriefRef } from '../cli-worker-startup.js';
import type { Job } from '../job-contracts.js';
import { jobFiles } from '../paths.js';
import { hudHome, jobsRoot, findJob } from '../store/job-store.js';

export function jobCwd(args: Args): string {
  if (args.cwd === undefined) return resolve(process.cwd());
  const cwd = resolve(required(args, 'cwd'));
  // A missing directory otherwise surfaces later as a misleading `spawn <launcher> ENOENT`.
  if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error('invalid_arguments: cwd is not an existing directory');
  return cwd;
}
export type Args = Record<string, unknown>;
export function required(args: Args, key: string): string {
  if (typeof args[key] !== 'string' || !args[key]) throw new Error(`invalid_arguments: ${key}`);
  return args[key] as string;
}

async function readContextFile(path: string, limit: number | undefined) {
  const file = await fs.promises.open(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('not a regular file');
    if (limit !== undefined && stat.size > limit) return null;
    // Validate the whole file, but only keep the body for browser briefs.
    const buffer = Buffer.alloc(64 * 1024);
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let content = '', bytes = 0;
    while (true) {
      const length = limit === undefined ? buffer.length : Math.min(buffer.length, limit - bytes + 1);
      const { bytesRead } = await file.read(buffer, 0, length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (limit !== undefined && bytes > limit) return null;
      const text = decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      if (/[\x00-\x08\x0e-\x1f\x7f]/.test(text)) throw new Error('binary content');
      if (limit !== undefined) content += text;
    }
    decoder.decode(); // Reject an incomplete final UTF-8 sequence.
    return { bytes, content };
  } finally {
    await file.close();
  }
}

const BRIEF_FILE_MAX_BYTES = 256 * 1024;
export async function readBriefFile(raw: unknown, cwd: string): Promise<{ task: string } | { ok: false; code: 'invalid_arguments' | 'context_too_large'; error: string }> {
  if (typeof raw !== 'string' || !raw || raw.includes('\0'))
    return { ok: false, code: 'invalid_arguments', error: 'invalid brief_file' };
  try {
    const base = await fs.promises.realpath(cwd);
    const path = await fs.promises.realpath(resolve(cwd, raw));
    const rel = relative(base, path);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('outside cwd');
    const file = await readContextFile(path, BRIEF_FILE_MAX_BYTES);
    if (!file) return { ok: false, code: 'context_too_large', error: `brief_file: ${JSON.stringify(raw)}` };
    if (!file.content.trim()) return { ok: false, code: 'invalid_arguments', error: 'brief_file is empty' };
    return { task: file.content };
  } catch {
    return { ok: false, code: 'invalid_arguments', error: `brief_file: ${JSON.stringify(raw)} must resolve to a readable UTF-8 text file inside ${cwd}` };
  }
}

const SONIC_FACTS_EN =
  'Sonic facts: unverified starting points with file:line; its unchecked list is where it did not look; read yourself any code you base a decision on.';
const SONIC_FACTS_ZH =
  'Sonic 事实：带 file:line 的未核实起点；未检查列表是它没有看的地方；凡是据此做决定的代码，请亲自阅读。';
function sonicFactsPrefix(task: unknown): string {
  if (typeof task !== 'string' || !task.trim()) return SONIC_FACTS_EN;
  const words = replyWords(task).replace(/\b(?:[\w]+[-./#][\w./#-]+|[A-Z\d_]{2,}|[0-9a-f]{7,40})\b/g, ' ');
  const han = words.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu)?.length ?? 0;
  const other = words.match(/[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/gu)?.length ?? 0;
  const latin = words.match(/[A-Za-z]/g)?.length ?? 0;
  return han > 0 && !(other >= 4 && other >= 0.2 * (han + other)) && (han >= 0.25 * (han + latin) || needsTranslation(task, 'en'))
    ? SONIC_FACTS_ZH
    : SONIC_FACTS_EN;
}

function inlineSection(label: string, content: string, prefix?: string): string {
  let length = 3;
  for (const run of content.matchAll(/`+/g)) length = Math.max(length, run[0].length + 1);
  const fence = '`'.repeat(length);
  return `${prefix ? `${prefix}\n\n` : ''}### ${label}\n\n${fence}\n${content}${content.endsWith('\n') ? '' : '\n'}${fence}`;
}

export async function assembleContext(args: Args, cwd: string, inline: boolean, project: { root: string; registered: boolean }, instructions: string, repairOf?: string) {
  // Clear any earlier preference receipt when starting a queued job with a different attachment.
  const metadata: Pick<Job, 'context_files' | 'from_jobs' | 'preferences_file' | 'preferences_warning'> = {
    preferences_file: undefined, preferences_warning: undefined,
  };
  const sections: string[] = [];
  const contextInputs: { name: string; bytes: number }[] = [];
  let remaining = 256 * 1024;
  const inside = (base: string, path: string) => {
    const rel = relative(base, path);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('outside its root');
  };
  const read = (path: string) => readContextFile(path, inline ? Math.min(64 * 1024, remaining) : undefined);
  const append = async (path: string, label: string, prefix?: string) => {
    const file = await read(path);
    if (!file) return null;
    if (inline) {
      remaining -= file.bytes;
      sections.push(inlineSection(label, file.content, prefix));
    } else sections.push(prefix ? `${prefix}\n- ${label}` : `- ${label}`);
    return file.bytes;
  };
  let standing: string | undefined;
  let standingLabel: string | undefined;
  let reference = '';
  if (project.registered) {
    const standingPath = join(project.root, '.hud', 'brief.md');
    try {
      const path = await fs.promises.realpath(standingPath);
      inside(project.root, path);
      if (inline) {
        if (await append(path, JSON.stringify(standingPath)) === null)
          return { ok: false, code: 'context_too_large', error: standingPath } as const;
      } else {
        if (!(await fs.promises.stat(path)).isFile()) throw new Error('not a regular file');
        // A heading here could replace the title of a task written without one.
        reference = `Read the project standing brief: ${JSON.stringify(standingPath)}.\n\n`;
      }
      standing = path;
      standingLabel = standingPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        return { ok: false, code: 'invalid_arguments', error: `${standingPath} must resolve to a readable text file inside ${project.root}` } as const;
    }
  }
  const sonicPrefix = sonicFactsPrefix(args.task);
  for (const [key, root, max] of [['context_files', cwd, 32], ['from_jobs', jobsRoot, 16]] as const) {
    const given = args[key];
    const repair = key === 'from_jobs' ? repairOf : undefined;
    if (given === undefined && !repair) continue;
    const values = given === undefined ? [] : given;
    if (!Array.isArray(values) || values.length > max || values.some((v) =>
      typeof v !== 'string' || !v || v.includes('\0') || (key === 'from_jobs' && !/^j[0-9a-f]{16}$/.test(v)))) {
      return { ok: false, code: 'invalid_arguments', error: `invalid ${key} (maximum ${max} entries)` } as const;
    }
    const recorded: string[] = metadata[key] = [];
    if (!values.length && !repair) continue;
    let source: string = key;
    try {
      const base = await fs.promises.realpath(root);
      const files: { value: string; name: 'report' | 'brief' | '' }[] = values.map((value) => ({ value, name: key === 'from_jobs' ? 'report' : '' }));
      if (repair) {
        if (!values.includes(repair)) files.push({ value: repair, name: 'report' });
        files.push({ value: repair, name: 'brief' });
      }
      for (const { value, name } of files) {
        source = `${key}: ${JSON.stringify(value)}`;
        const path = await fs.promises.realpath(resolve(root, name ? join(value, jobFiles[name]) : value));
        inside(base, path);
        const label = `${name ? `${value} ${name}: ` : ''}${JSON.stringify(path)}`;
        let sonic = false;
        if (key === 'from_jobs' && name === 'report') {
          try { sonic = findJob(value)?.role === 'sonic'; } catch { /* Corrupt receipt leaves sonic false. */ }
        }
        const bytes = path === standing
          ? (await readContextFile(path, undefined))!.bytes // Explicit context still requires UTF-8 text.
          : await append(path, label, sonic ? sonicPrefix : undefined);
        if (bytes === null) return { ok: false, code: 'context_too_large', error: source } as const;
        if (!name) contextInputs.push({ name: relative(base, path).slice(0, 512), bytes });
        if (!name || (name === 'report' && (value !== repair || values.includes(value)))) recorded.push(name ? value : path);
      }
    } catch {
      return { ok: false, code: 'invalid_arguments', error: `${source} must resolve to a readable UTF-8 text file inside ${root}` } as const;
    }
  }
  // Fit the optional preferences after required context, but present them before the standing brief.
  if (basename(instructions) === instructions && instructions !== '.' && instructions !== '..') {
    const root = join(hudHome, 'preferences');
    const name = `${instructions}.md`;
    const label = join(root, name);
    try {
      const directory = await fs.promises.realpath(root);
      inside(await fs.promises.realpath(hudHome), directory);
      const file = await read(join(directory, name));
      if (!file) {
        metadata.preferences_warning = `Skipped owner preferences ${JSON.stringify(label)}: exceeds the browser context budget`;
      } else {
        metadata.preferences_file = label;
        if (inline) sections.unshift(inlineSection(JSON.stringify(label), file.content));
        else reference = `${ownerPreferencesReference(label)}\n\n${reference}`;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        metadata.preferences_warning = `Skipped owner preferences ${JSON.stringify(label)}: expected a readable UTF-8 text file inside HUD_HOME`;
      }
    }
  }
  const block = !sections.length ? '' : inline
    ? `\n## Context\n\n${sections.join('\n\n')}\n`
    : `## Context References\n\nRead these files for task context:\n\n${sections.join('\n')}\n\n`;
  return {
    metadata,
    contextInputs,
    block: reference + block,
    standing: standing && standingLabel ? { path: standing, label: standingLabel } satisfies StandingBriefRef : undefined,
  };
}
