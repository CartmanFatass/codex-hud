#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number);
if (!((major === 22 && minor >= 13) || major >= 24)) {
  process.stderr.write('hud-claude-hook requires Node 22.x >=22.13 or Node >=24 (23 unsupported)\n');
  process.exitCode = 1;
} else {
  try {
    const { runHook } = await import('../dist/packages/hud-mcp/src/hook/command.js');
    await runHook(process.argv[2]);
  } catch {
    // No input, paths, IDs or secrets in errors. MCP independently refuses absent evidence.
    process.stderr.write('HUD call-source evidence unavailable\n');
    process.exitCode = 1;
  }
}
