/** Finite parent relay. The real MCP entry remains a child of Claude through this adapter. */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { ClaudeBinding } from './binding.js';
export function mcpLaunch(binding: ClaudeBinding, parent: NodeJS.ProcessEnv) {
  return {
    command: binding.node,
    args: [join(binding.release, 'packages/hud-mcp/bin/hud-mcp.mjs')],
    env: { ...parent, HUD_HOME: binding.hudHome, HUD_MCP_SURFACE: 'roles' },
  };
}
export async function mcpMain(binding: ClaudeBinding): Promise<void> {
  const launch = mcpLaunch(binding, process.env);
  const child = spawn(launch.command, launch.args, { env: launch.env, stdio: 'inherit' });
  const term = () => child.kill('SIGTERM');
  const interrupt = () => child.kill('SIGINT');
  process.on('SIGTERM', term);
  process.on('SIGINT', interrupt);
  try {
    process.exitCode = await new Promise<number>((resolve) => {
      child.once('error', () => resolve(2));
      child.once('exit', (code) => resolve(code ?? 2));
    });
  } finally {
    process.off('SIGTERM', term);
    process.off('SIGINT', interrupt);
  }
}
