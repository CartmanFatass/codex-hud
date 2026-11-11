/**
 * The bin only serves the thin local pi-roles server.
 * Accept `roles` for existing installed registrations.
 */

export function selectMcpEntry(surface) {
  if (surface === undefined || surface === 'roles') return '../dist/packages/hud-mcp/src/thin-main.js';
  throw new Error(`unknown_surface: ${JSON.stringify(surface)}`);
}
