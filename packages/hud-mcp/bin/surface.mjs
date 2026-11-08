/**
 * Entry selection for the bin. Unset loads the managed surface.
 * `roles` loads the role facade. Anything else throws before either entry is imported.
 * Keep this in step with `packages/hud-mcp/src/surface.ts`.
 */

export function selectMcpEntry(surface) {
  if (surface === undefined) return '../dist/packages/hud-mcp/src/main.js';
  if (surface === 'roles') return '../dist/packages/hud-mcp/src/role-main.js';
  throw new Error(`unknown_surface: ${JSON.stringify(surface)}`);
}
