/** Shared MCP and native pi declarations; importing them never starts a server. */
import { LEASE_TOOL } from './lease.js';
import { MAX_CHECK_COMMAND, MAX_CHECKS } from './job-checks.js';

const text = { type: 'string' };
const bool = { type: 'boolean' };
const detail = { ...bool, description: 'Diagnostics.' };
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
  tool('hud_roster', 'Role availability, effective assignments; new/changed project dispatch convention.', {
    cwd: { ...text, description: 'Project dir; default server cwd.' },
    convention_version: text,
    detail: { ...bool, description: 'Presets, fallbacks, sources, valid options.' },
  }),
  tool(
    'hud_create',
    'Single: role + task/brief_file; batch: jobs; retry: retry_of. Placement: role files/Control. Single general job only: preset/on/model/thinking. Fresh request_key for duplicates. Options: hud_roster(detail:true).',
    {
      role: text,
      request_key: { ...text, description: 'Permanent key; omit for 10-min caller/role/cwd/task dedupe.' },
      task: text,
      brief_file: { ...text, description: 'UTF-8 task file within cwd.' },
      jobs: {
        type: 'array',
        minItems: 1,
        items: { type: 'object' },
        description: 'Without MCP tasks; else parallel single creates.',
      },
      scout: { ...text, minLength: 1, description: 'Ask sonic first, attach report; non-sonic only.' },
      retry_of: { ...text, description: 'Failed/stopped ID; reuse brief/options at available place.' },
      cwd: { ...text, description: 'Job/project dir; default server cwd.' },
      package: { ...text, description: 'Display label.' },
      ticket: { ...text, description: 'feature/NN ticket link.' },
      slice: { ...text, description: 'Legacy target label.' },
      context_files: { type: 'array', items: text, maxItems: 32, description: 'Text paths in cwd.' },
      checks: { type: 'array', maxItems: MAX_CHECKS, items: { ...text, minLength: 1, maxLength: MAX_CHECK_COMMAND },
        description: 'HUD runs in job cwd after declared pi/CLI settlement.' },
      from_jobs: {
        type: 'array',
        items: { ...text, pattern: '^j[0-9a-f]{16}$' },
        maxItems: 16,
        description: 'Report context without marking read.',
      },
      isolation: {
        type: 'string',
        enum: ['none', 'worktree'],
        default: 'none',
        description: 'Managed local Git checkout from HEAD.',
      },
      mode: { ...text, enum: ['tab', 'headless'], description: 'Headless: continuable pi/Claude/Antigravity; Imp routing may select it.' },
      idle_grace_s: { type: 'integer', minimum: 60, maximum: 3600, description: 'CLI only.' },
      on: { ...text, description: 'Harness/provider: pi|agy|claude|codex|grok|chatgpt|gemini|argon|flow.' },
      preset: { ...text, description: 'Preset name; excludes on.' },
      instructions: { ...text, description: 'Borrow role (general only).' },
      kind: { type: 'string', enum: ['image', 'video'], description: 'Flow only (default image).' },
      model: { ...text, description: 'Model (pi/CLI).' },
      thinking: { ...text, description: 'Thinking effort (pi/CLI).' },
      lens: { ...bool, description: 'Pi: pi-lens.' },
      mcp: { ...bool, description: 'Pi: MCP adapter.' },
      tps: { ...bool, description: 'Pi: tokens/s.' },
      ui_ext: { ...bool, description: 'Pi: false disables UI extensions.' },
      skills: { ...bool, description: 'Pi: true adds personal skills.' },
      split: { ...bool, description: 'Pi: right helper pane.' },
      pi_args: {
        type: 'array',
        items: { ...text, maxLength: 4096 },
        maxItems: 128,
        description: 'Pi argv; general-only placement; --orchestrator/--notify reserved.',
      },
    }
  ),
  tool(
    'hud_read',
    "List active project jobs + caller's unread settled reports or collect job/jobs. Digest: summary, paths, questions, checks, progress. Full: paged report/path/diagnostics. Pi/CLI close at turn end with a declared report, read or not; inspect via hud_peek.",
    {
      job: text,
      jobs: { type: 'array', items: text, minItems: 1, description: 'Input order; per-item errors.' },
      mode: { ...text, enum: ['digest', 'full'], default: 'digest' },
      offset: { type: 'integer', minimum: 0, description: 'Single full read: byte next_offset from prior page.' },
      wait_ms: { type: 'integer', minimum: 0, maximum: 120000, description: 'For settlement/attention.' },
      full: { ...bool, description: 'Legacy mode: full alias.' },
      detail: { ...bool, description: 'Job only: launch diagnostics.' },
      view: {
        type: 'string',
        enum: ['compact', 'recent'],
        description: 'List only: compact counts children, folds older unread reports; recent: newest 20 full rows incl. children.',
      },
    }
  ),
  tool(
    'hud_wait',
    "Await settlement/attention; no report reads. Default: caller's unsettled jobs.",
    {
      jobs: { type: 'array', items: text },
      mode: { type: 'string', enum: ['any', 'all'], default: 'any' },
      wait_ms: { type: 'integer', minimum: 0, maximum: 120000, default: 60000 },
    }
  ),
  tool(
    'hud_peek',
    'Status/progress; never marks read or closes worker.',
    {
      job: text,
      lines: { type: 'integer', minimum: 1, maximum: 120, description: 'Recent pane line count.' },
      detail,
    },
    ['job']
  ),
  tool(
    'hud_send',
    'Send via one: job, jobs (working jobs), messages (distinct text). Closed: resume native session or start repair (continued_as); continuation says which.',
    {
      job: text,
      jobs: { type: 'array', items: text, minItems: 1 },
      message_key: { ...text, description: 'Permanent key; omit for 10-min job/text dedupe.' },
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
        description: 'Input order; per-item errors.',
      },
    }
  ),
  tool(
    'hud_respond',
    'Answer once or batch via answers.',
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
        description: 'Input order; per-item errors.',
      },
    }
  ),
  tool('hud_close', 'Reap early; repeat-safe.', { job: text }, ['job']),
  tool('hud_land', 'Land settled managed worktree job via project gate; hud_read returned flow ID.', { job: text }, ['job']),
  LEASE_TOOL,
  tool(
    'hud_tickets',
    'Ticket guide/ready list; add/update local; sync GitHub mirror.',
    {
      op: { ...text, enum: ['guide', 'ready', 'add', 'update', 'sync'], default: 'guide' },
      cwd: { ...text, description: 'Project dir; default server cwd.' },
      feature: { ...text, pattern: '^[a-z0-9-]+$', description: 'Add/update: slug.' },
      tickets: {
        type: 'array',
        minItems: 1,
        description: 'Add drafts, blockers first.',
        items: {
          type: 'object',
          properties: {
            title: text,
            blocked_by: blockers,
            what: text,
            acceptance: { type: 'array', items: text },
            status: { ...ticketStatus, default: 'ready-for-agent' },
            owner_try: { type: 'boolean', description: 'Owner tries post-land (default yes).' },
          },
          required: ['title', 'blocked_by', 'what', 'acceptance'],
          additionalProperties: false,
        },
      },
      ticket: { ...ticketNumber, description: 'Update only.' },
      status: { ...ticketStatus, description: 'Update only.' },
      owner_try: { type: 'boolean', description: 'Update: yes/no.' },
      blocked_by: { ...blockers, description: 'Update: replace blockers (local numbers or feature/NN).' },
      tick: { type: 'array', items: ticketNumber, description: 'Update: tick 1-based acceptance items.' },
      updates: {
        type: 'array',
        minItems: 1,
        description: 'Update batch: input order, per-item errors; item feature wins.',
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
