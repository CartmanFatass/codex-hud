import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writePrivateFile } from '../utils/atomic-fs.js';
import type { RolePlace } from '../roles/roster.js';
import { jobFiles } from './paths.js';
import { briefPrompt, readInlineText } from './brief-prompt.js';
import { codexWorkerMcp } from './codex-worker-mcp.js';

export interface StandingBriefRef {
  path: string;
  label: string;
}

function stripLast(text: string, needle: string): string {
  const at = text.lastIndexOf(needle);
  return at < 0 ? text : text.slice(0, at) + text.slice(at + needle.length);
}

function agyFirstPrompt(briefPath: string, instructions: string, standingBrief?: StandingBriefRef): string {
  const role = readInlineText(instructions);
  const standing = standingBrief ? readInlineText(standingBrief.path) : null;
  const standingRef = standingBrief ? `Read the project standing brief: ${JSON.stringify(standingBrief.label)}.` : '';
  const brief = readInlineText(briefPath);
  const briefSection = brief !== null
    ? `Carry out this brief:\n\n${standing !== null ? stripLast(brief, `${standingRef}\n\n`) : brief}`
    : `Read ${briefPath} and do exactly what it asks.`;

  const parts: string[] = [];
  if (role !== null) {
    if (role.trim()) parts.push(role.trimEnd());
  } else {
    parts.push(`Read ${instructions} for your role instructions.`);
  }
  if (standingBrief) {
    if (standing !== null) {
      if (standing.trim()) parts.push(`Project standing brief (${JSON.stringify(standingBrief.label)}):\n\n${standing.trimEnd()}`);
    } else if (!briefSection.includes(standingRef)) {
      parts.push(standingRef);
    }
  }
  parts.push(briefSection);
  return parts.join('\n\n');
}

function claudeServers(names: Set<string>): [string, unknown][] {
  if (!names.size) return [];
  let servers;
  try {
    const file = join(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json');
    servers = JSON.parse(readFileSync(file, 'utf8')).mcpServers;
  } catch { throw new Error('could not read Claude user MCP config'); }
  return [...names].map((name) => {
    if (!servers || !Object.hasOwn(servers, name)) throw new Error(`Claude user MCP server not found: ${name}`);
    return [name, servers[name]];
  });
}

export function cliWorkerStartup(place: RolePlace, cwd: string, dir: string, instructions: string,
  entry: string, allowed: readonly string[], standingBrief?: StandingBriefRef): { args: string[]; prompt: string; warning?: string } {
  const briefPath = join(dir, jobFiles.brief);
  if (place.agent === 'agy') return { args: [], prompt: agyFirstPrompt(briefPath, instructions, standingBrief) };
  const prompt = briefPrompt(briefPath);
  const role = readFileSync(instructions, 'utf8');
  if (place.agent === 'grok') return { args: ['--rules', role], prompt };

  const names = new Set(allowed);
  names.delete('hud'); // Always bind the bundled server to this job, never a configured namesake.
  const hud = { command: process.execPath, args: [entry], env: { HUD_JOB_DIR: dir, HUD_MCP_SURFACE: 'roles' } };
  if (place.agent === 'claude') {
    if (place.args?.some((arg) => /^--mcp-config(?:=|$)/.test(arg)))
      throw new Error('use the role mcp_servers field instead of --mcp-config');
    const file = join(dir, jobFiles.workerMcp);
    writePrivateFile(file, JSON.stringify({ mcpServers: Object.fromEntries([['hud', hud], ...claudeServers(names)]) }));
    return { args: ['--strict-mcp-config', '--mcp-config', file, '--append-system-prompt', role], prompt };
  }

  const args = ['-c', `developer_instructions=${JSON.stringify(role)}`];
  try { return { args: [...args, ...codexWorkerMcp(cwd, place.args ?? [], names, hud)], prompt }; }
  catch (error) { return { args, prompt, warning: `mcp scope not applied: ${(error as Error).message}` }; }
}
