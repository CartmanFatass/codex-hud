/** Shared MCP and native pi declarations; importing them never starts a server. */
import { LEASE_TOOL } from './lease.js';
import { MAX_CHECK_COMMAND, MAX_CHECKS } from './job-checks.js';

const text = { type: 'string' };
const bool = { type: 'boolean' };
const detail = { ...bool, description: 'Include diagnostics.' };
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
});

export const TICKET_STATUSES = ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'wontfix', 'claimed', 'done'] as const;
const ticketStatus = { ...text, enum: TICKET_STATUSES };
const ticketNumber = { type: 'integer', minimum: 1 };
const blockers = { type: 'array', items: { anyOf: [ticketNumber, { type: 'string', pattern: '^[a-z0-9-]+/[0-9]+$' }] } };

export const ROLE_TOOLS = [
  tool('hud_roster', 'Get role availability, effective assignments, and the project dispatch convention when new or changed.', {
    cwd: { ...text, description: 'Project directory (default: server cwd).' },
    convention_version: text,
    detail: { ...bool, description: 'Include presets, fallbacks, sources and accepted options.' },
  }),
  tool(
    'hud_create',
    'Dispatch a role (role + task or brief_file), retry a failed/stopped job (retry_of), or batch-create with jobs: [...]. An identical call within 10 minutes returns the same job; pass a fresh request_key for an intentional duplicate. Omit preset, on, model and thinking unless the user requests them. See hud_roster(detail:true) for other role options.',
    {
      role: text,
      request_key: { ...text, description: 'Optional permanent idempotency key. If omitted, the same caller, role, cwd and task match for 10 minutes.' },
      task: text,
      brief_file: { ...text, description: 'UTF-8 text path within cwd used as task.' },
      jobs: {
        type: 'array',
        minItems: 1,
        items: { type: 'object' },
        description: 'Batch create; items take single-create fields (no nested jobs).',
      },
      scout: { ...text, minLength: 1, description: 'Run sonic on this question first and attach its report. Not available for role sonic.' },
      retry_of: { ...text, description: 'Failed or stopped job ID. Reuses its brief and options and selects an available place.' },
      cwd: { ...text, description: 'Job directory and project context (default: server cwd).' },
      package: { ...text, description: 'Display label.' },
      ticket: { ...text, description: 'Linked ticket: feature/NN.' },
      slice: { ...text, description: 'Linked STATE slice ID.' },
      context_files: { type: 'array', items: text, maxItems: 32, description: 'Text paths within cwd.' },
      checks: { type: 'array', maxItems: MAX_CHECKS, items: { ...text, minLength: 1, maxLength: MAX_CHECK_COMMAND },
        description: 'Commands the HUD runs in the job cwd after a declared pi or CLI settlement.' },
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
    'List the project’s active jobs and the caller’s unread settled reports, or collect by job or jobs. Default: report digest, changed paths, open questions, check outcomes and latest progress. Full mode includes report text, path and diagnostics. Reading a settled report closes the worker; use hud_peek to inspect.',
    {
      job: text,
      jobs: { type: 'array', items: text, minItems: 1, description: 'Read each job in order of input; errors are per item.' },
      mode: { ...text, enum: ['digest', 'full'], default: 'digest' },
      wait_ms: { type: 'integer', minimum: 0, maximum: 120000, description: 'Wait for settlement or attention.' },
      full: { ...bool, description: 'Legacy alias for mode: full.' },
      detail: { ...bool, description: 'Job only: include launch diagnostics.' },
      view: {
        type: 'string',
        enum: ['compact', 'recent'],
        description: 'List only (no job). Compact counts child jobs and folds older unread reports; recent gives the newest 20 full rows, including children.',
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
    'Send text to one job, fan out one text to working jobs (jobs), or send distinct messages (messages: [{job, text, message_key?}]). A single or messages send to a job closed by reading its report starts a repair (continued_as). Use one of job, jobs or messages.',
    {
      job: text,
      jobs: { type: 'array', items: text, minItems: 1 },
      message_key: { ...text, description: 'Optional permanent idempotency key. If omitted, the same job and text match for 10 minutes.' },
      text,
      messages: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: { job: text, text, message_key: text },
          required: ['job', 'text'],
          additionalProperties: false,
        },
        description: 'Batch sends in input order; errors are per item.',
      },
    }
  ),
  tool(
    'hud_respond',
    'Write a question answer once, or batch-answer with answers: [{job, request_id, answer}].',
    {
      job: text,
      request_id: text,
      answer: text,
      answers: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: { job: text, request_id: text, answer: text },
          required: ['job', 'request_id', 'answer'],
          additionalProperties: false,
        },
        description: 'Batch answers in input order; errors are per item.',
      },
    }
  ),
  tool('hud_close', 'Reap a job early; safe to repeat.', { job: text }, ['job']),
  tool('hud_land', 'Land a settled managed worktree job through the project gate. Read the returned flow ID with hud_read.', { job: text }, ['job']),
  LEASE_TOOL,
  tool(
    'hud_tickets',
    'Read the ticket method, list ready tickets, add or update local tickets, or sync a GitHub mirror.',
    {
      op: { ...text, enum: ['guide', 'ready', 'add', 'update', 'sync'], default: 'guide' },
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
            blocked_by: blockers,
            what: text,
            acceptance: { type: 'array', items: text },
            status: { ...ticketStatus, default: 'ready-for-agent' },
            owner_try: { type: 'boolean', description: 'Whether the owner needs to try it after landing (default: yes).' },
          },
          required: ['title', 'blocked_by', 'what', 'acceptance'],
          additionalProperties: false,
        },
      },
      ticket: { ...ticketNumber, description: 'Ticket number for update.' },
      status: { ...ticketStatus, description: 'New status for update.' },
      owner_try: { type: 'boolean', description: 'For update: set Owner try yes/no.' },
      blocked_by: { ...blockers, description: 'For update: replace blockers (local numbers or feature/NN).' },
      tick: { type: 'array', items: ticketNumber, description: 'For update: 1-based acceptance items to check.' },
      updates: {
        type: 'array',
        minItems: 1,
        description: 'For update: batch updates in input order (item feature overrides top-level feature); errors are per item.',
        items: {
          type: 'object',
          properties: {
            feature: { ...text, pattern: '^[a-z0-9-]+$' },
            ticket: ticketNumber,
            status: ticketStatus,
            owner_try: { type: 'boolean' },
            blocked_by: blockers,
            tick: { type: 'array', items: ticketNumber },
          },
          required: ['ticket'],
          additionalProperties: false,
        },
      },
    }
  ),
];
