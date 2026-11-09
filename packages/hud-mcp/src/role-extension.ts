/**
 * Role-facade tools. This module does not import the native agent host.
 * The default hud-mcp entry still serves managed_* until R6; start this surface
 * with HUD_MCP_SURFACE=roles.
 */

import type { AuthenticatedToolExtension } from './server.js';
import type { CallResolution } from './resolvers.js';
import type { JevExecutor } from '../../../src/roles/facade.js';
import { parseRosterRoot } from '../../../src/roles/selection.js';
import { dispatchRoleTool, ROLE_TOOLS, type RoleToolDefinition } from '../../../src/roles/role-tools.js';
import type { ToolDefinition } from './tools.js';

type Resolved = Extract<CallResolution, { ok: true }>;

export class RoleFacadeTools implements AuthenticatedToolExtension {
  readonly tools: ToolDefinition[] = ROLE_TOOLS.map((tool) => tool as RoleToolDefinition as ToolDefinition);
  constructor(
    private readonly home: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly jev: JevExecutor | null = null,
    private readonly admission?: (source: Resolved) => void
  ) {}
  async invoke(source: Resolved, name: string, args: Record<string, unknown>): Promise<unknown> {
    this.admission?.(source);
    const root = parseRosterRoot(`${source.sessionRef.sourceId}/${source.sessionRef.sessionId}`);
    return dispatchRoleTool({ home: this.home, root, env: this.env, jev: this.jev }, name, args);
  }
}
