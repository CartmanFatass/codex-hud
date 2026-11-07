import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadDelegateConfig, RETIRE_DEFAULTS } from '../../packages/hud-mcp/src/config.js';
import { TOOLS, type ToolDefinition } from '../../packages/hud-mcp/src/tools.js';
import { MANAGED_TOOLS } from '../../packages/hud-mcp/src/managed-tools.js';
import { JEV_TOOLS } from '../../packages/hud-mcp/src/jev-tools.js';

const repo = new URL('../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, repo), 'utf8');

const PARENT = 'integrations/skills/hud-delegate/SKILL.md';
const IMPLEMENTER = 'integrations/skills/hud-delegate/roles/implementer.md';
const REVIEWER = 'integrations/skills/hud-delegate/roles/reviewer.md';
const HANDOFF = 'integrations/skills/hud-handoff/SKILL.md';

/** Retained historical role and handoff documents. The parent file is the fixed-role roster skill. */
const HISTORICAL_SKILL_FILES = [IMPLEMENTER, REVIEWER, HANDOFF];

/** Design §6: sections mandatory and in this order. */
const HANDOFF_SECTIONS = [
  '# Handoff: <slug>',
  '## Task (what the successor must deliver; acceptance commands)',
  '## State: done / in progress / not started (file paths; tests green; verified vs assumed)',
  '## Decisions made and why (bullets; cite docs/contract sections, not chat)',
  '## Open questions and known risks',
  '## Outstanding delegations (linkId/runId, state, what the successor may only *observe*; resolved before handoff unless listed here)',
  '## Next steps (ordered; command and expected result)',
  "## Pointers (files to read first; report paths; the handoff's own path)",
  '## Content rule: actual task state the successor needs; no secrets or credentials; no transcript excerpts beyond what the task needs;',
];

function catalog(tools: ToolDefinition[]) {
  const names = new Set(tools.map((tool) => tool.name));
  const schemaKeys = new Map(
    tools.map((tool) => [tool.name, new Set(Object.keys(tool.inputSchema.properties as Record<string, unknown>))])
  );
  return { names, schemaKeys, argumentKeys: new Set([...schemaKeys.values()].flatMap((keys) => [...keys])) };
}
const NATIVE_CATALOG = catalog([...MANAGED_TOOLS, ...JEV_TOOLS]);
const HISTORICAL_CATALOG = catalog(TOOLS);
const documentCatalog = (name: string) => (name === PARENT ? NATIVE_CATALOG : HISTORICAL_CATALOG);

/**
 * Complete identifiers, case-sensitive. A valid lowercase prefix of a misspelled name must not
 * pass, and a call whose name is invalid must still be parsed so its arguments are checked.
 */
const TOOL_MENTION = /\b(?:delegate|managed|jev)_[A-Za-z0-9_]+/gi;
const TOOL_CALL = /\b((?:delegate|managed|jev)_[A-Za-z0-9_]+)\{/gi;

interface Coverage {
  names: number;
  calls: number;
  keys: number;
}
interface Call {
  tool: string;
  keys: string[];
}
interface Scan {
  names: string[];
  calls: Call[];
  keys: string[];
}

/**
 * Drift floor per document: a document that loses its tool names, calls or argument keys fails
 * here instead of passing with zero matches. Every floor is above zero on purpose.
 */
const MINIMUM = new Map<string, Coverage>([
  [PARENT, { names: 20, calls: 10, keys: 20 }],
  [IMPLEMENTER, { names: 7, calls: 3, keys: 10 }],
  [REVIEWER, { names: 5, calls: 2, keys: 7 }],
  [HANDOFF, { names: 2, calls: 1, keys: 4 }],
]);

/** Splits a `tool_name{...}` body on top-level commas and keeps the leading identifier of each part. */
function topLevelKeys(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of body) {
    if (character === '{' || character === '[') depth++;
    else if (character === '}' || character === ']') depth--;
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts
    .map((part) => /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(part)?.[1])
    .filter((key): key is string => key !== undefined);
}

/** `tool_name{key, key: value, …}` mentions, with brace matching so nested values stay one mention. */
function braceCalls(text: string): Call[] {
  const calls: Call[] = [];
  const start = new RegExp(TOOL_CALL.source, TOOL_CALL.flags);
  for (let match = start.exec(text); match; match = start.exec(text)) {
    let depth = 0;
    let end = -1;
    for (let index = match.index + match[0].length - 1; index < text.length; index++) {
      if (text[index] === '{') depth++;
      else if (text[index] === '}' && --depth === 0) {
        end = index;
        break;
      }
    }
    if (end < 0) continue;
    calls.push({ tool: match[1], keys: topLevelKeys(text.slice(match.index + match[0].length, end)) });
    start.lastIndex = end + 1;
  }
  return calls;
}

/** JSON blocks in the skill documents are tool calls: `{"tool": "tool_name", "arguments": {...}}`. */
function jsonCalls(text: string): Call[] {
  return [...text.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => {
    const value = JSON.parse(match[1]) as { tool?: unknown; arguments?: unknown };
    assert.ok(typeof value.tool === 'string', 'a JSON block in the skill documents must name its tool');
    assert.ok(
      value.arguments !== null && typeof value.arguments === 'object' && !Array.isArray(value.arguments),
      'a JSON block in the skill documents must carry an arguments object'
    );
    return { tool: value.tool, keys: Object.keys(value.arguments as Record<string, unknown>) };
  });
}

function scanDocument(text: string): Scan {
  const names = [...text.matchAll(new RegExp(TOOL_MENTION.source, TOOL_MENTION.flags))].map((match) => match[0]);
  const calls = [...braceCalls(text), ...jsonCalls(text)];
  return { names, calls, keys: calls.flatMap((call) => call.keys) };
}

/** Fails on an unknown tool, an unknown argument key, or a document that names too little to check. */
function checkDocument(name: string, text: string, minimum: Coverage, tools = documentCatalog(name)): void {
  const scan = scanDocument(text);
  for (const tool of scan.names) assert.ok(tools.names.has(tool), `${name} names an unknown tool: ${tool}`);
  for (const call of scan.calls) {
    assert.ok(tools.names.has(call.tool), `${name} calls an unknown tool: ${call.tool}`);
    const keys = tools.schemaKeys.get(call.tool)!;
    for (const key of call.keys) assert.ok(keys.has(key), `${name} names an unknown ${call.tool} argument: ${key}`);
  }
  for (const field of ['names', 'calls', 'keys'] as const)
    assert.ok(
      scan[field].length >= minimum[field] && minimum[field] > 0,
      `${name} has ${scan[field].length} extracted ${field}, expected at least ${minimum[field]} (never zero)`
    );
}

/** Fenced blocks are templates or JSON, not prose; strip them before reading inline code spans. */
const stripFences = (text: string) => text.replace(/```[\s\S]*?```/g, '');
const INLINE_CODE = /`([^`\n]+)`/g;
/** Lowercase snake_case only: argument keys, refusal codes, reason strings. */
const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

/**
 * Lowercase snake_case tokens the documents may use that the MCP does not return as a refusal code.
 * `run_in_background`: the Claude Code background-task option.
 * `stale_generation`: `hud run wait` exit code (src/cli/run-wait.ts:96).
 * `visible_scope_control_unavailable`: cancel result reason (packages/hud-mcp/src/read-control.ts:385).
 */
const NON_REFUSAL_TOKENS = new Set(['run_in_background', 'stale_generation', 'visible_scope_control_unavailable']);

/** The wake adapter names `advice.wake.adapter` can carry, read from their source of truth. */
function shippedWakeAdapters(): Set<string> {
  const body = /adapter: ((?:'[^']+'\s*\|?\s*)+);/.exec(read('src/ledger/notify-events.ts'))?.[1];
  assert.ok(body, 'the wake adapter names could not be read from src/ledger/notify-events.ts');
  const adapters = new Set([...body.matchAll(/'([^']+)'/g)].map((match) => match[1]));
  assert.equal(adapters.size, 4, `the wake adapter list parsed to ${adapters.size} names, not the shipped four`);
  return adapters;
}

/** The model-facing whitelist from the shipped `outcomeCode`, read from its source of truth. */
function shippedRefusalCodes(): Set<string> {
  const body = /const outcomeCodes = new Set\(\[([\s\S]*?)\]\)/.exec(read('packages/hud-mcp/src/errors.ts'))?.[1];
  assert.ok(body, 'the model-facing error whitelist could not be read from packages/hud-mcp/src/errors.ts');
  const codes = new Set([...body.matchAll(/'([^']+)'/g)].map((match) => match[1]));
  // Capacity is an outcome, not a thrown error (src/ledger/intents.ts:237).
  codes.add('concurrency_limit');
  assert.ok(codes.size >= 40, `the shipped error set parsed to ${codes.size} codes, which is too few to trust`);
  return codes;
}

test('B13 docs/delegate.example.json loads through the shipped delegate.json validator', (t: TestContext) => {
  const file = fileURLToPath(new URL('docs/delegate.example.json', repo));
  const example = JSON.parse(readFileSync(file, 'utf8')) as { profiles: { source: { root: string } }[] };
  // The production loader requires every source root to exist as a directory. The
  // example names synthetic roots; create exactly those and remove only what this test made.
  const created: string[] = [];
  for (const profile of example.profiles) {
    const root = profile.source.root;
    assert.match(root, /^\/tmp\/synthetic-[a-z0-9-]+$/, 'example source roots stay synthetic');
    if (existsSync(root)) continue;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    created.push(root);
  }
  t.after(() => {
    for (const root of created) rmSync(root, { recursive: true, force: true });
  });
  const config = loadDelegateConfig(file);
  assert.equal(config.version, 1);
  assert.deepEqual(config.profiles.map((profile) => profile.name).sort(), ['codex-implementer', 'codex-reviewer']);
  for (const profile of config.profiles) {
    assert.equal(profile.harness, 'codex');
    assert.ok(profile.headless, `${profile.name} needs a headless template`);
    assert.deepEqual(profile.retire, { ...RETIRE_DEFAULTS });
  }
});

test('B13 historical role and handoff documents use only their shipped tools and argument keys', () => {
  for (const path of HISTORICAL_SKILL_FILES) checkDocument(path, read(path), MINIMUM.get(path)!);
});

/**
 * Synthetic native-tool corpus. The installed parent skill no longer carries these
 * calls; this fixture keeps the scanner's typo checks above a non-zero floor.
 */
const NATIVE_SCANNER_CORPUS = [
  'managed_list managed_status managed_read managed_wait managed_requests managed_respond',
  'managed_cancel managed_close managed_create managed_send managed_ask',
  'jev_create jev_run jev_snapshot jev_command jev_list jev_close',
  'managed_wait{connectionId, afterSeq, waitMs}',
  'managed_create{profileId, workspace, origin}',
  'managed_send{connectionId, text}',
  'managed_read{connectionId, options}',
  'managed_respond{connectionId, requestId, result}',
  'managed_cancel{connectionId, nativeTurnId}',
  'managed_close{connectionId}',
  'managed_ask{connectionId, text, waitMs}',
  'managed_status{connectionId}',
  'jev_run{instanceId}',
  'jev_create{url, goals}',
].join('\n');

test('B13 scanner rejects suffix typos, case typos, key typos and empty documents', () => {
  const parent = NATIVE_SCANNER_CORPUS;
  const minimum = MINIMUM.get(PARENT)!;
  const suffix = parent.replaceAll('managed_wait', 'managed_waitX');
  assert.notEqual(suffix, parent, 'the scanner corpus must mention managed_wait for this control');
  assert.throws(() => checkDocument(PARENT, suffix, minimum), /unknown tool/);
  const casing = parent.replaceAll('managed_wait', 'Managed_Wait');
  assert.notEqual(casing, parent, 'the scanner corpus must mention managed_wait for this control');
  assert.throws(() => checkDocument(PARENT, casing, minimum), /unknown tool/);
  const key = parent.replaceAll('afterSeq', 'afterSeqX');
  assert.notEqual(key, parent, 'the scanner corpus must mention afterSeq for this control');
  assert.throws(() => checkDocument(PARENT, key, minimum), /unknown managed_wait argument/);
  assert.throws(() => checkDocument(PARENT, '', minimum), /expected at least/);
  const historical = parent.replaceAll('managed_wait', 'delegate_wait');
  assert.throws(() => checkDocument(PARENT, historical, minimum), /unknown tool/);
  const jevTypo = parent.replaceAll('jev_run', 'jev_runX');
  assert.notEqual(jevTypo, parent, 'the scanner corpus must cover Jev');
  assert.throws(() => checkDocument(PARENT, jevTypo, minimum), /unknown tool/);
});

test('B13 skill inline codes match the appropriate shipped API or documented native event', () => {
  const codes = shippedRefusalCodes();
  const adapters = shippedWakeAdapters();
  for (const path of HISTORICAL_SKILL_FILES) {
    const tools = documentCatalog(path);
    // Native result/event names are protocol vocabulary, not historical MCP refusal codes.
    const nativeEvents = new Set(['agent_end', 'agent_settled']);
    for (const match of stripFences(read(path)).matchAll(INLINE_CODE)) {
      const token = match[1];
      if (!SNAKE_CASE.test(token) || tools.names.has(token)) continue;
      assert.ok(
        (path === PARENT ? nativeEvents.has(token) : codes.has(token) || adapters.has(token)) ||
          tools.argumentKeys.has(token) ||
          NON_REFUSAL_TOKENS.has(token),
        `${path} names a code or key the shipped MCP does not return: ${token}`
      );
    }
  }
});

test('R1 delegation skill states the fixed roles, the recipes, and roster lookup', () => {
  const text = read(PARENT);
  for (const role of ['oracle', 'imp', 'reviewer', 'sonic', 'jev']) assert.match(text, new RegExp(`\\b${role}\\b`));
  assert.match(text, /oracle\.propose/);
  assert.match(text, /oracle\.converge/);
  assert.match(text, /hud roster show/);
  assert.match(text, /The main session owns every handoff/);
  assert.match(text, /Dispatch with the existing herdr \/ jev recipes using the resolved binding/);
  assert.match(text, /Arm the returned wait mechanism/);
  assert.match(text, /read results when notified/);
  assert.match(text, /question channel/);
  assert.match(text, /indicated location/);
  assert.match(text, /Keep request keys stable/);
  assert.match(text, /never blindly re-create an uncertain launch/);
  assert.match(text, /source: default \(no session identity\)/);
  assert.doesNotMatch(text, /\bR\d\b/);
  assert.match(text, /Design\./);
  assert.match(text, /Build\./);
  assert.match(text, /Small task\./);
  assert.match(text, /Browser task\./);
  assert.doesNotMatch(text, /```json/);
  assert.doesNotMatch(text, /\b(?:managed|delegate|jev)_[A-Za-z0-9_]+\b/);
  assert.doesNotMatch(text, /gpt-|grok-|claude-|opus|workflow_plan|workflow_start|selector/i);
  for (const match of stripFences(text).matchAll(INLINE_CODE)) {
    assert.equal(SNAKE_CASE.test(match[1]), false, `${PARENT} has a snake_case code: ${match[1]}`);
  }
});

test('B13 hud-handoff skill carries the design §6 sections in order', () => {
  const text = read(HANDOFF);
  let cursor = -1;
  for (const section of HANDOFF_SECTIONS) {
    const at = text.indexOf(section, cursor + 1);
    assert.ok(at > cursor, `hud-handoff skill is missing this section, or has it out of order: ${section}`);
    cursor = at;
  }
});
