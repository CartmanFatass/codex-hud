// Source-only surface selection rejects invalid registrations before importing dist.

export function selectMcpEntry(surface) {
  if (surface === undefined || surface === 'roles') return '../../../dist/mcp/thin-main.js';
  throw new Error(`unknown_surface: ${JSON.stringify(surface)}`);
}
