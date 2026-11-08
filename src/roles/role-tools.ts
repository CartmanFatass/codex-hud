/**
 * Static schemas for the six role tools. The role enum does not change when a
 * preset changes. `packages/hud-mcp` serves these without the native agent host.
 */

import { ORACLE_PHASES, ROLES } from './roles.js';
import { hudClose, hudCreate, hudRead, hudRespond, hudRoster, hudSend, type FacadeContext } from './facade.js';

export interface RoleToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const role = { type: 'string', enum: [...ROLES] };
const phase = { type: 'string', enum: [...ORACLE_PHASES] };
const job = { type: 'string', minLength: 1, maxLength: 64, pattern: '^j[a-f0-9]{16}$' };
const key = { type: 'string', minLength: 1, maxLength: 200 };
const preset = { type: 'string', minLength: 1, maxLength: 64 };

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[]
): RoleToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
  };
}

export const ROLE_TOOLS: readonly RoleToolDefinition[] = [
  tool(
    'hud_roster',
    'List routing presets, show the preset this main session will use next, or select one for this session only.',
    { action: { type: 'string', enum: ['list', 'show', 'select'] }, preset },
    ['action']
  ),
  tool(
    'hud_create',
    'Create one job for a fixed role. Oracle requires phase propose or converge. The same request_key and the same request return the same job.',
    {
      role,
      phase,
      request_key: key,
      task: { type: 'string', minLength: 1, maxLength: 65536 },
      cwd: { type: 'string', minLength: 1, maxLength: 4096 },
      preset,
      profile: preset,
      input: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['ask', 'browse', 'judge'] },
          text: { type: 'string', minLength: 1, maxLength: 65536 },
          statements: {
            type: 'array',
            maxItems: 32,
            items: { type: 'string', minLength: 1, maxLength: 2000 },
          },
        },
        required: ['kind'],
        additionalProperties: false,
      },
    },
    ['role', 'request_key']
  ),
  tool(
    'hud_read',
    'Read one job, or list this session’s jobs when job is omitted. wait_ms waits for a herdr state change. Idle is not acceptance.',
    { job, wait_ms: { type: 'integer', minimum: 0, maximum: 120000 } },
    []
  ),
  tool(
    'hud_send',
    'Send one follow-up to an open job. The same message_key and the same text are not sent twice.',
    { job, message_key: key, text: { type: 'string', minLength: 1, maxLength: 4096 } },
    ['job', 'message_key', 'text']
  ),
  tool(
    'hud_respond',
    'Answer one outstanding pi question by writing qN.answer.md, or return a handoff when the backend has no such channel.',
    {
      job,
      request_id: { type: 'string', minLength: 2, maxLength: 8 },
      answer: { type: 'string', minLength: 1, maxLength: 16384 },
    },
    ['job', 'request_id', 'answer']
  ),
  tool(
    'hud_close',
    'Quit the job’s agent and close its herdr tab. A repeated close keeps the result and does not launch anything.',
    { job },
    ['job']
  ),
];

export async function dispatchRoleTool(
  ctx: FacadeContext,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (name) {
    case 'hud_roster':
      return hudRoster(ctx, args);
    case 'hud_create':
      return hudCreate(ctx, args);
    case 'hud_read':
      return hudRead(ctx, args);
    case 'hud_send':
      return hudSend(ctx, args);
    case 'hud_respond':
      return hudRespond(ctx, args);
    case 'hud_close':
      return hudClose(ctx, args);
    default:
      return { ok: false, code: 'unknown_tool' };
  }
}
