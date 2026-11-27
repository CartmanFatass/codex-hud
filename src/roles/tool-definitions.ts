/** Shared MCP and native pi declarations; importing them never starts a server. */
import { LEASE_TOOL } from './lease.js';
import { MAX_CHECK_COMMAND, MAX_CHECKS } from './job-checks.js';
import { FEATURE_SLUG, OBJECTIVE_SLUG, OBJECTIVE_STATES, PROJECT_PRIORITIES, PROJECT_STANCES } from '../collectors/objectives.js';
import { SCHEDULE_DATE, SCHEDULE_ID, SCHEDULE_TEXT_MAX } from '../collectors/schedule.js';
import { TICKET_KINDS, TICKET_ROLES, TICKET_STATUSES } from '../tickets/store.js';

const text = { type: 'string' };
export const EXPERIMENT_TAG_MAX_LENGTH = 64;
const experimentTag = { ...text, maxLength: EXPERIMENT_TAG_MAX_LENGTH };
const experimentTags = { experiment: experimentTag, arm: experimentTag };
const bool = { type: 'boolean' };
const detail = { ...bool, description: 'Diagnostics.' };
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false },
});

const ticketStatus = { ...text, enum: TICKET_STATUSES };
const ticketObjective = { ...text, pattern: OBJECTIVE_SLUG };
const ticketNumber = { type: 'integer', minimum: 1 };
const ticketRef = { ...text, pattern: '^[a-z0-9-]+/[0-9]+$' };
const canonicalTicketRef = { ...text, pattern: '^[a-z0-9-]+/[0-9]{2,}$' };
const blockers = { type: 'array', items: { anyOf: [ticketNumber, ticketRef] } };
const repairs = { type: 'array', items: canonicalTicketRef };
const ticketSpec = {
  title: text, what: text, live_try: text, approved_removals: { anyOf: [text, { type: 'array', items: text }] },
  kind: { ...text, enum: TICKET_KINDS }, role: { ...text, enum: TICKET_ROLES }, main_review: bool,
  repo: text,
};
const ticketUpdate = {
  ...ticketSpec, status: ticketStatus, owner_try: bool, objective: ticketObjective, blocked_by: blockers, repairs,
  tick: { type: 'array', items: ticketNumber, description: 'Check acceptance IDs.' },
  acceptance: { type: 'array', items: { type: 'object', properties: { id: ticketNumber, text }, required: ['id', 'text'], additionalProperties: false } },
  comment: { ...text, description: 'Append a comment.' },
};

export const ROLE_TOOLS = [
  tool('hud_roster', 'Roles, assignments, convention.', {
    cwd: { ...text, description: 'Project dir; default server cwd.' },
    convention_version: text,
    detail: { ...bool, description: 'Presets, fallbacks, options.' },
  }),
  tool(
    'hud_create',
    'One job or a pilot-gated items batch. Single general job only: preset/on/model/thinking.',
    {
      role: text,
      request_key: text,
      items: { type: 'array', items: { type: 'object', properties: { task: text, brief_file: text, package: text } } },
      max_parallel: { type: 'integer', minimum: 1 }, batch: text, action: { ...text, enum: ['pause', 'resume', 'stop', 'retry_failed'] },
      task: text,
      brief_file: text,
      members: { type: 'array', items: text, minItems: 2, maxItems: 5, description: 'Council presets.' },
      synthesizer: { ...text, description: 'Council synthesis preset or main.' },
      preview: { ...text, maxLength: 260 },
      jobs: {
        type: 'array',
        minItems: 1,
        items: { type: 'object', properties: experimentTags },
        description: 'Batch without MCP tasks.',
      },
      scouts: {
        type: 'array',
        maxItems: 3,
        items: { type: 'object', properties: { kind: { ...text, enum: ['code', 'docs', 'web'] }, ask: text }, required: ['kind', 'ask'] },
        description: '0-3 scouts ([] skips).',
      },
      prewalk: bool,
      retry_of: { ...text, description: 'Retry failed/stopped ID.' },
      cwd: text,
      package: { ...text, description: 'Display label.' },
      ticket: { ...text, description: 'feature/NN; default brief.' },
      ...experimentTags,
      slice: text,
      context_files: { type: 'array', items: text, maxItems: 32, description: 'Text paths in cwd.' },
      checks: { type: 'array', maxItems: MAX_CHECKS, items: { ...text, minLength: 1, maxLength: MAX_CHECK_COMMAND },
        description: 'Post-settlement checks (pi/CLI).' },
      from_jobs: {
        type: 'array',
        items: { ...text, pattern: '^j[0-9a-f]{16}$' },
        maxItems: 16,
        description: 'Reports; not marked read.',
      },
      isolation: {
        type: 'string',
        enum: ['none', 'worktree'],
        default: 'none',
        description: 'Managed Git worktree from HEAD.',
      },
      mode: { ...text, enum: ['tab', 'headless'], description: 'Headless: pi/Claude/Agy; Imp routing may select it.' },
      idle_grace_s: { type: 'integer', minimum: 60, maximum: 3600, description: 'CLI only.' },
      on: { ...text, description: 'pi|agy|claude|codex|grok|chatgpt|gemini|argon|flow.' },
      preset: { ...text, description: 'Preset name; excludes on.' },
      instructions: { ...text, description: 'Borrow role (general only).' },
      kind: { type: 'string', enum: ['image', 'video'], description: 'Flow; default image.' },
      model: text,
      thinking: { ...text, description: 'Thinking effort (pi/CLI).' },
      lens: bool,
      mcp: bool,
      tps: bool,
      ui_ext: { ...bool, description: 'Pi: false disables UI extensions.' },
      skills: { ...bool, description: 'Pi: true adds personal skills.' },
      split: { ...bool, description: 'Pi: right helper pane.' },
      pi_args: {
        type: 'array',
        items: { ...text, maxLength: 4096 },
        maxItems: 128,
        description: 'Pi argv; general only.',
      },
    }
  ),
  tool(
    'hud_read',
    "List active project jobs + caller's unread reports; read job/jobs for digest or paged full report. Pi/CLI close at turn end with a declared report, read or not; inspect via hud_peek.",
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
        description: 'Compact groups children/old unread; recent: latest 20.',
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
    'job/jobs (working)/messages. Closed: resume or repair (continued_as).',
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
    'Answer once, batch, or run hand-back (job=w... or q...); by:"owner" relays owner.',
    {
      job: text,
      request_id: text,
      answer: text,
      by: { ...text, enum: ['owner'] },
      answers: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: { job: text, request_id: text, answer: text, by: { ...text, enum: ['owner'] } },
          required: ['job', 'answer'],
          additionalProperties: false,
        },
        description: 'Input order; per-item errors.',
      },
    }
  ),
  tool('hud_close', 'job: close a running worker. Batch: cancel queued work (never started; no worker).', {
    job: text,
    jobs: { type: 'array', items: text, minItems: 1, description: 'Queued (no worker); skip running.' },
    package: { ...text, description: 'With state:queued; caller/project only.' },
    state: { ...text, enum: ['queued'] }, preset: text,
  }),
  tool('hud_land', 'Land settled worktree via project gate; hud_read flow ID.', { job: text }, ['job']),
  tool('hud_workflow', 'Main only: plan a frozen JSON graph or TOML template (no launches); start by confirming run/hash; status or control. Costly plans require a bound owner grant.', {
    op: { ...text, enum: ['plan', 'start', 'status', 'control'] },
    graph: { anyOf: [{ type: 'object' }, text], description: 'Version 1 graph with named steps, needs and from.' },
    template: { ...text, description: 'TOML name in project or HUD workflows directory.' },
    cwd: text, params: { type: 'object' }, run: { ...text, pattern: '^w[0-9a-f]{16}$' },
    hash: text, confirm: bool, action: { ...text, enum: ['pause', 'resume', 'stop', 'retry_failed'] },
  }, ['op']),
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
    features: { type: 'array', items: { ...text, pattern: FEATURE_SLUG }, description: 'Ticket feature slugs.' },
    stance: { ...text, enum: PROJECT_STANCES },
    priority: { ...text, enum: PROJECT_PRIORITIES },
    text,
    objective: { ...text, pattern: OBJECTIVE_SLUG },
    waits: { type: 'boolean' },
    request: { ...text, pattern: '^r\\d+$' },
    resolution: { ...text, enum: ['resolved', 'withdrawn'], default: 'resolved' },
    note: text,
  }, ['op']),
  tool('hud_schedule', 'Owner dates across projects. A schedule item says when; a hud_objective request says someone waits. Dates never turn into requests. add: date and one-line text in the panel language, optional registered project and its Objective. move: id and date. Resolve with done: id. list: open items by date with stage (far, soon, today, overdue); due:true filters to today or overdue.', {
    op: { ...text, enum: ['add', 'done', 'move', 'list'] },
    date: { ...text, pattern: SCHEDULE_DATE, description: 'Local YYYY-MM-DD or YYYY-MM (due on its last day).' },
    text: { ...text, minLength: 1, maxLength: SCHEDULE_TEXT_MAX },
    project: { ...text, description: 'Registered project directory.' },
    objective: { ...text, pattern: OBJECTIVE_SLUG },
    id: { ...text, pattern: SCHEDULE_ID },
    note: { ...text, description: 'Optional context for done; not saved.' },
    due: bool,
  }, ['op']),
  tool(
    'hud_tickets',
    'Get/edit JSON tickets; commit HUD writes. Add links feature to Objective. repo: registered target root (~/... or absolute).',
    {
      op: { ...text, enum: ['guide', 'ready', 'get', 'run', 'add', 'update', 'commit', 'sync'], default: 'guide' },
      cwd: text,
      feature: { ...text, pattern: '^[a-z0-9-]+$', description: 'Get/run/add/update: slug.' },
      run: { ...text, pattern: '^q[0-9a-f]{16}$', description: 'Run: cancel ID (incl. unattended).' },
      max_parallel: { type: 'integer', minimum: 1, description: 'Run: max in-flight; default imp cap.' },
      cancel: { type: 'boolean', description: 'Run: cancel; keeps jobs/lands.' },
      escalation_rule: text,
      handback_to: { ...text, enum: ['lead', 'main'] },
      tickets: {
        type: 'array',
        minItems: 1,
        description: 'Blockers first.',
        items: {
          type: 'object',
          properties: {
            ...ticketSpec,
            blocked_by: blockers,
            repairs,
            acceptance: { type: 'array', items: text },
            status: { ...ticketStatus, default: 'ready-for-agent' },
            owner_try: { type: 'boolean', description: 'Owner try post-land (default no).' },
            objective: ticketObjective,
          },
          required: ['title', 'blocked_by', 'what', 'acceptance'],
          additionalProperties: false,
        },
      },
      ticket: { anyOf: [ticketNumber, ticketRef], description: 'Number with feature, or feature/NN.' },
      ...ticketUpdate,
      updates: {
        type: 'array',
        minItems: 1,
        description: 'Results in input order; per-item errors or receipts; item feature wins.',
        items: {
          type: 'object',
          properties: {
            feature: { ...text, pattern: '^[a-z0-9-]+$' },
            ticket: ticketNumber,
            ...ticketUpdate,
          },
          required: ['ticket'],
          additionalProperties: false,
        },
      },
    }
  ),
];
