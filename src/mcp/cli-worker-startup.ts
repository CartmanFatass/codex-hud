import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writePrivateFile } from '../utils/atomic-fs.js';
import type { RolePlace } from '../roles/roster.js';
import { jobFiles } from './paths.js';
import { briefPrompt } from './brief-prompt.js';
import { codexWorkerMcp } from './codex-worker-mcp.js';

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
  entry: string, allowed: readonly string[]): { args: string[]; prompt: string; warning?: string } {
  const prompt = briefPrompt(join(dir, jobFiles.brief));
  if (place.agent === 'agy') return { args: [], prompt: `Read ${instructions} for your role instructions.\n\n${prompt}` };
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
