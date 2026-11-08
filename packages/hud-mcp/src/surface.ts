/**
 * Which hud-mcp entry a process loads.
 * Unset is the managed surface. `roles` is the fixed-role facade.
 * Any other value, including the empty string, is an error.
 * Keep this in step with `packages/hud-mcp/bin/surface.mjs`.
 */

export function selectMcpEntry(surface: string | undefined): string {
  if (surface === undefined) return '../dist/packages/hud-mcp/src/main.js';
  if (surface === 'roles') return '../dist/packages/hud-mcp/src/role-main.js';
  throw new Error(`unknown_surface: ${JSON.stringify(surface)}`);
}
