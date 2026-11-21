/** Shared MCP and native pi declarations; importing them never starts a server. */
import { LEASE_TOOL } from './lease.js';

const text = { type: 'string' };
const bool = { type: 'boolean' };
const detail = { ...bool, description: 'Include diagnostics.' };
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
});

export const TICKET_STATUSES = ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'wontfix'] as const;
const ticketStatus = { ...text, enum: TICKET_STATUSES };
const ticketNumber = { type: 'integer', minimum: 1 };

export const ROLE_TOOLS = [
  tool('hud_roster', 'Get role availability, effective assignments and the project dispatch convention when new or changed.', {
    cwd: { ...text, description: 'Project directory (default: server cwd).' },
    convention_version: text,
    detail: { ...bool, description: 'Include presets, fallbacks, sources and accepted options.' },
  }),
  tool(
    'hud_create',
    'Dispatch a role (requires role and task), or retry a failed or stopped job with retry_of, inheriting its task and options unless overridden. An identical call within 10 minutes returns the same job; pass a fresh request_key for an intentional duplicate. Omit preset, on, model and thinking unless the user requests them. See hud_roster(detail:true) for role options.',
    {
      role: text,
      request_key: { ...text, description: 'Optional permanent idempotency key. If omitted, the same caller, role, cwd and task match for 10 minutes.' },
      task: text,
      retry_of: { ...text, description: 'Failed or stopped job ID. Reuses its brief and options and selects an available place.' },
      cwd: { ...text, description: 'Job directory and project context (default: server cwd).' },
      package: { ...text, description: 'Display label.' },
      context_files: { type: 'array', items: text, maxItems: 32, description: 'Text paths within cwd.' },
      from_jobs: {
        type: 'array',
        items: { ...text, pattern: '^j[0-9a-f]{16}$' },
        maxItems: 16,
        description: 'Use reports as context without marking them read.',
      },
      isolation: {
        type: 'string',
        enum: ['none', 'worktree'],
        default: 'none',
        description: 'Managed Git checkout from HEAD (local only).',
      },
      idle_grace_s: { type: 'integer', minimum: 60, maximum: 3600, description: 'CLI only.' },
      on: { ...text, description: 'Harness/provider: pi, agy, claude, codex, grok, chatgpt, gemini, argon, flow.' },
      preset: { ...text, description: 'Named role preset; mutually exclusive with on.' },
      kind: { type: 'string', enum: ['image', 'video'], description: 'Flow only (default image).' },
      model: { ...text, description: 'Pi or CLI model.' },
      thinking: { ...text, description: 'Pi or CLI effort.' },
      lens: { ...bool, description: 'Pi: pi-lens.' },
      mcp: { ...bool, description: 'Pi: MCP adapter.' },
      tps: { ...bool, description: 'Pi: tokens/s.' },
      ui_ext: { ...bool, description: 'Pi: false disables UI extensions.' },
      skills: { ...bool, description: 'Pi: true includes personal skills.' },
      split: { ...bool, description: 'Pi: reserve a right helper pane.' },
      pi_args: {
        type: 'array',
        items: { ...text, maxLength: 4096 },
        maxItems: 128,
        description: 'Pi argv after --; --orchestrator and --notify are reserved.',
      },
    }
  ),
  tool(
    'hud_read',
    'List active jobs or collect one job’s report. Reading a settled report closes the worker. For inspection use hud_peek.',
    {
      job: text,
      wait_ms: { type: 'integer', minimum: 0, maximum: 120000, description: 'Wait for settlement or attention.' },
      full: { ...bool, description: 'Include the report even if already read.' },
      detail: { ...bool, description: 'Job only: include launch diagnostics.' },
      view: {
        type: 'string',
        enum: ['compact', 'recent'],
        description: 'List only (no job); recent gives the newest 20 full rows.',
      },
    }
  ),
  tool(
    'hud_wait',
    'Wait for settlement or attention without reading reports. Omit jobs for the caller’s unsettled jobs.',
    {
      jobs: { type: 'array', items: text },
      mode: { type: 'string', enum: ['any', 'all'], default: 'any' },
      wait_ms: { type: 'integer', minimum: 0, maximum: 120000, default: 60000 },
    }
  ),
  tool(
    'hud_peek',
    'Inspect status and progress without marking anything read or closing the worker.',
    {
      job: text,
      lines: { type: 'integer', minimum: 1, maximum: 120, description: 'Fetch this many recent pane lines.' },
      detail,
    },
    ['job']
  ),
  tool(
    'hud_send',
    'Send text to one job, or use jobs to send only to working jobs and get sent and skipped lists. A single send to a job closed by reading its report starts a repair and returns continued_as. Use either job or jobs.',
    {
      job: text,
      jobs: { type: 'array', items: text, minItems: 1 },
      message_key: { ...text, description: 'Optional permanent idempotency key. If omitted, the same job and text match for 10 minutes.' },
      text,
    },
    ['text']
  ),
  tool('hud_respond', 'Write a question answer once.', { job: text, request_id: text, answer: text }, [
    'job',
    'request_id',
    'answer',
  ]),
  tool('hud_close', 'Reap a job early; safe to repeat.', { job: text }, ['job']),
  LEASE_TOOL,
  tool(
    'hud_tickets',
    'Read the ticket method (default), add or update local tickets, or sync a GitHub mirror. Only the main session can write.',
    {
      op: { ...text, enum: ['guide', 'add', 'update', 'sync'], default: 'guide' },
      cwd: { ...text, description: 'Project directory (default: server cwd).' },
      feature: { ...text, pattern: '^[a-z0-9-]+$', description: 'Feature slug for add and update.' },
      tickets: {
        type: 'array',
        minItems: 1,
        description: 'For add: drafts, blockers first.',
        items: {
          type: 'object',
          properties: {
            title: text,
            blocked_by: { type: 'array', items: ticketNumber },
            what: text,
            acceptance: { type: 'array', items: text },
            status: { ...ticketStatus, default: 'ready-for-agent' },
          },
          required: ['title', 'blocked_by', 'what', 'acceptance'],
          additionalProperties: false,
        },
      },
      ticket: { ...ticketNumber, description: 'Ticket number for update.' },
      status: { ...ticketStatus, description: 'New status for update.' },
      tick: { type: 'array', items: ticketNumber, description: 'For update: 1-based acceptance items to check.' },
    }
  ),
];
