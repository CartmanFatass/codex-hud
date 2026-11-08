#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number);
if (!((major === 22 && minor >= 13) || major >= 24)) {
  process.stderr.write(
    `hud-mcp requires Node 22.x >=22.13.0 or Node >=24 (Node 23 is unsupported) (running ${process.versions.node}); the HUD bar supports Node >=18.\n`
  );
  process.exit(1);
}
import { selectMcpEntry } from './surface.mjs';

let entry;
try {
  entry = selectMcpEntry(process.env.HUD_MCP_SURFACE);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'unknown_surface'}\n`);
  process.exit(1);
}
try {
  await import(entry);
} catch (error) {
  process.stderr.write(`hud-mcp startup failed: ${error instanceof Error ? error.message : 'unknown_error'}\n`);
  process.exitCode = 1;
}
