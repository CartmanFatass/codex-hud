/** Shared MCP and native pi declarations; importing them never starts a server. */
import { LEASE_TOOL } from './lease.js';
import { MAX_CHECK_COMMAND, MAX_CHECKS } from './job-checks.js';
import { FEATURE_SLUG, OBJECTIVE_SLUG, OBJECTIVE_STATES, PROJECT_PRIORITIES, PROJECT_STANCES } from '../collectors/objectives.js';

const text = { type: 'string' };
export const EXPERIMENT_TAG_MAX_LENGTH = 64;
const experimentTag = { ...text, maxLength: EXPERIMENT_TAG_MAX_LENGTH };
const experimentTags = { experiment: experimentTag, arm: experimentTag };
const bool = { type: 'boolean' };
const detail = { ...bool, description: 'Diagnostics.' };
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
});

export const TICKET_STATUSES = ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'wontfix', 'claimed', 'done'] as const;
const ticketStatus = { ...text, enum: TICKET_STATUSES };
const ticketObjective = { ...text, pattern: OBJECTIVE_SLUG };
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
    'Create or retry jobs. Placement: role files/Control; overrides: single general only. Options: hud_roster(detail:true).',
    {
      role: text,
      request_key: { ...text, description: 'Fresh key to repeat; omit for 10-min caller/role/cwd/task dedupe.' },
      task: text,
      brief_file: { ...text, description: 'UTF-8 task file within cwd.' },
      preview: { ...text, maxLength: 260, description: 'HTML path relative to cwd; opened on report.' },
      jobs: {
        type: 'array',
        minItems: 1,
        items: { type: 'object', properties: experimentTags },
        description: 'Without MCP tasks; else parallel single creates.',
      },
      scout: { ...text, minLength: 1, description: 'Ask sonic first, attach report; non-sonic only.' },
      retry_of: { ...text, description: 'Failed/stopped ID; reuse brief/options at available place.' },
      cwd: { ...text, description: 'Job/project dir; default server cwd.' },
      package: { ...text, description: 'Display label.' },
      ticket: { ...text, description: 'feature/NN ticket link.' },
      ...experimentTags,
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
  tool('hud_objective', 'Edit registered projects without committing. set: Objective id and fields (new: title and state). project: stance/priority. request: text and optional Objective/waits. resolve: request ID and optional resolution/note.', {
    op: { ...text, enum: ['set', 'project', 'request', 'resolve'] },
    cwd: { ...text, description: 'Project dir; default server cwd.' },
    id: { ...text, pattern: OBJECTIVE_SLUG },
    title: text,
    state: { ...text, enum: OBJECTIVE_STATES },
    next: text,
    result: text,
    evidence: { type: 'array', items: text, description: 'Repo paths, URLs or commit hashes.' },
    features: { type: 'array', items: { ...text, pattern: FEATURE_SLUG }, description: '.scratch feature slugs.' },
    stance: { ...text, enum: PROJECT_STANCES },
    priority: { ...text, enum: PROJECT_PRIORITIES },
    text,
    objective: { ...text, pattern: OBJECTIVE_SLUG },
    waits: { type: 'boolean' },
    request: { ...text, pattern: '^r\\d+$' },
    resolution: { ...text, enum: ['resolved', 'withdrawn'], default: 'resolved' },
    note: text,
  }, ['op']),
  tool(
    'hud_tickets',
    'Tickets: guide, queue, local edits, GitHub sync. Add/update objective: ID in .hud/objectives.md.',
    {
      op: { ...text, enum: ['guide', 'ready', 'run', 'add', 'update', 'sync'], default: 'guide' },
      cwd: text,
      feature: { ...text, pattern: '^[a-z0-9-]+$', description: 'Run/add/update: slug.' },
      max_parallel: { type: 'integer', minimum: 1, description: 'Run: max in-flight; default imp cap.' },
      cancel: { type: 'boolean', description: 'Run: cancel; keeps jobs/lands.' },
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
            owner_try: { type: 'boolean', description: 'Owner try post-land (default no).' },
            objective: ticketObjective,
          },
          required: ['title', 'blocked_by', 'what', 'acceptance'],
          additionalProperties: false,
        },
      },
      ticket: ticketNumber,
      status: ticketStatus,
      owner_try: bool,
      objective: ticketObjective,
      blocked_by: { ...blockers, description: 'Update: replace blockers.' },
      tick: { type: 'array', items: ticketNumber, description: 'Update: 1-based acceptance items.' },
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
            objective: ticketObjective,
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
