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

// Herdr's agent.start shell encoder rejects U+0000–001F and U+007F–009F
// (Unicode Cc). agent.prompt uses a separate transport.
export function isHerdrAgentArg(value: string): boolean {
  return !/\p{Cc}/u.test(value);
}

/** Encode controls that JSON.stringify leaves literal, e.g. DEL and C1. */
function escapeArgControls(value: string): string {
  return value.replace(/\p{Cc}/gu, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function stripLast(text: string, needle: string): string {
  const at = text.lastIndexOf(needle);
  return at < 0 ? text : text.slice(0, at) + text.slice(at + needle.length);
}

function firstPromptWithRole(briefPath: string, instructions: string, standingBrief?: StandingBriefRef): string {
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
  entry: string, allowed: readonly string[], standingBrief?: StandingBriefRef, advisor = false): { args: string[]; prompt: string; warning?: string } {
  const briefPath = join(dir, jobFiles.brief);
  if (place.agent === 'agy') return { args: [], prompt: firstPromptWithRole(briefPath, instructions, standingBrief) };
  if (place.agent === 'grok') {
    const role = readFileSync(instructions, 'utf8');
    return isHerdrAgentArg(role)
      ? { args: ['--rules', role], prompt: briefPrompt(briefPath) }
      : { args: [], prompt: firstPromptWithRole(briefPath, instructions) };
  }

  const prompt = briefPrompt(briefPath);
  const names = new Set(allowed);
  names.delete('hud'); // Always bind the bundled server to this job, never a configured namesake.
  const hud = { command: process.execPath, args: [entry], env: { HUD_JOB_DIR: dir, HUD_MCP_SURFACE: 'roles' } };
  if (place.agent === 'claude') {
    if (place.args?.some((arg) => /^--mcp-config(?:=|$)/.test(arg)))
      throw new Error('use the role mcp_servers field instead of --mcp-config');
    const file = join(dir, jobFiles.workerMcp);
    // Exempt only the bundled worker tools from Claude Code's tool-search deferral.
    // https://code.claude.com/docs/en/mcp#exempt-a-server-from-deferral
    writePrivateFile(file, JSON.stringify({ mcpServers: Object.fromEntries([['hud', { ...hud, alwaysLoad: true }], ...claudeServers(names)]) }));
    const args = ['--strict-mcp-config', '--mcp-config', file];
    if (advisor) return { args: [...args, '--tools', '', '--setting-sources', ''], prompt };
    return isHerdrAgentArg(instructions)
      ? { args: [...args, '--append-system-prompt-file', instructions], prompt }
      : { args, prompt: firstPromptWithRole(briefPath, instructions) };
  }

  const role = readFileSync(instructions, 'utf8');
  const args = ['-c', `developer_instructions=${escapeArgControls(JSON.stringify(role))}`];
  try { return { args: [...args, ...codexWorkerMcp(cwd, place.args ?? [], names, hud)], prompt }; }
  catch (error) { return { args, prompt, warning: `mcp scope not applied: ${(error as Error).message}` }; }
}
