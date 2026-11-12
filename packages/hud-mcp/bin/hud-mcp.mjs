#!/usr/bin/env node
const major = Number(process.versions.node.split('.')[0]);
if (major < 24) {
  process.stderr.write(
    `hud-mcp requires Node >=24.0.0 (running ${process.versions.node}).\n`
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
