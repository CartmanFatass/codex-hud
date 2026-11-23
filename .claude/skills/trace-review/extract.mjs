#!/usr/bin/env node
import { createHmac, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const home = homedir();
const repo = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const jobId = /^j[0-9a-f]{16}$/i;
const within = (root, file) => file === root || file.startsWith(root.replace(/\/$/, '') + '/');
const redactIds = text => text.replace(/\bj[0-9a-f]{16}\b/gi, '<job>')
  .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|\b[0-9a-f]{24,}\b/gi, '<id>');

function displayFile(file) {
  if (within(repo, file)) return redactIds(path.relative(repo, file) || '.');
  const project = file.match(/^(?:\/home\/[^/]+|\/Users\/[^/]+)\/(?:projects|repos|workspaces)\/([^/]+)(?:\/(.*))?$/);
  if (project) {
    if (project[1] === 'MyHUD') return redactIds(project[2] || '.');
    if (project[1] === 'MyHUD-wt') return redactIds(`~/projects/MyHUD-wt/<worktree>/${project[2]?.split('/').slice(1).join('/') || ''}`);
    return '<other-repo>';
  }
  if (within(home, file) || /^\/(?:home|Users)\/[^/]+(?:\/|$)/.test(file)) {
    const tail = within(home, file) ? path.relative(home, file) : file.split('/').slice(3).join('/');
    // Keep only names needed to recognize a class of home file, not arbitrary private paths.
    const hud = tail.match(/^\.hud\/jobs\/j[0-9a-f]{16}\/(job\.json|STATUS\.json|brief\.md|report\.md|SESSION\.txt)$/i);
    if (hud) return `~/.hud/jobs/<job>/${hud[1]}`;
    return tail ? '~/<private>' : '~';
  }
  return '<other-repo>';
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
const bytes = text => Buffer.byteLength(text);
const list = value => Array.isArray(value) ? value : [];
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
function json(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}
function textParts(value) {
  if (typeof value === 'string') return [value];
  return list(value).flatMap(block => typeof block?.text === 'string' ? [block.text] : []);
}
function payloadBytes(value) {
  if (typeof value === 'string') return bytes(value);
  if (Array.isArray(value)) return value.reduce((sum, block) => sum + payloadBytes(typeof block?.text === 'string' ? block.text : block), 0);
  return value == null ? 0 : bytes(JSON.stringify(value));
}

function usage(fields) {
  const u = Object.fromEntries(Object.entries(fields).filter(([, v]) => finite(v) !== undefined));
  return Object.keys(u).length ? u : undefined;
}
const sum = (a, b, c) => finite(a) === undefined ? undefined : a + (finite(b) ?? 0) + (finite(c) ?? 0);
function claudeUsage(u = {}) {
  return usage({ inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadTokens: u.cache_read_input_tokens,
    cacheWriteTokens: u.cache_creation_input_tokens, cacheWrite5mTokens: u.cache_creation?.ephemeral_5m_input_tokens,
    cacheWrite1hTokens: u.cache_creation?.ephemeral_1h_input_tokens, thinkingTokens: u.output_tokens_details?.thinking_tokens,
    contextTokens: sum(u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens) });
}

function shellRead(command) {
  // Not a shell parser: accept only single commands with one literal path.
  const match = typeof command === 'string' && command.trim().match(/^(?:cat[ \t]+(?:--[ \t]+)?|sed[ \t]+-n[ \t]+['"](\d+),(\d+)p['"][ \t]+(?:--[ \t]+)?)(['"]?)([\w./@+-]+)\3$/);
  if (!match || match[4].startsWith('-')) return;
  const start = match[1] === undefined ? 1 : Number(match[1]);
  const end = match[2] === undefined ? undefined : Number(match[2]);
  if (!integer(start) || (end !== undefined && (!integer(end) || end < start))) return;
  return { file: match[4], start, end, shell: true };
}
function readArgs(name, a, cwd) {
  let spec;
  if (name === 'Read' || name === 'read') {
    const start = integer(a?.offset) || 1;
    const count = integer(a?.limit) || undefined;
    spec = { file: a?.file_path ?? a?.path, start, end: count === undefined ? undefined : integer(start + count - 1) };
  } else if (name === 'read_file' || name === 'view_file') {
    spec = { file: a?.Path ?? a?.AbsolutePath ?? a?.absolute_path ?? a?.path,
      start: integer(a?.StartLine ?? a?.start_line) || 1, end: integer(a?.EndLine ?? a?.end_line) || undefined };
  } else if (['Bash', 'bash', 'exec_command', 'run_command'].includes(name)) {
    spec = shellRead(a?.command ?? a?.cmd ?? a?.CommandLine);
    cwd = a?.workdir ?? a?.Cwd ?? cwd;
  }
  if (typeof spec?.file !== 'string' || !spec.file) return;
  const file = spec.file;
  if (!path.isAbsolute(file) && !path.isAbsolute(cwd ?? '') && !file.startsWith('~/')) return;
  return { ...spec, file: path.resolve(cwd ?? '/', file.startsWith('~/') ? path.join(home, file.slice(2)) : file),
    wholeRequested: spec.start === 1 && spec.end === undefined };
}

function numberedRange(text) {
  // Claude's text read is one 1-based number and tab per source line.
  let first, last;
  for (const match of text.matchAll(/^[ \t]*(\d+)\t/gm)) {
    const n = Number(match[1]);
    if (!integer(n)) return;
    if (last !== undefined && n !== last + 1) break;
    first ??= n;
    last = n;
  }
  if (first !== undefined) return [first, last];
}
function lineCount(text) {
  if (!text) return 0;
  let count = text.endsWith('\n') ? 0 : 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++;
  return count;
}
function addRange(ranges, start, end) {
  let duplicate = 0, from = start, to = end, i = 0;
  while (i < ranges.length && ranges[i][1] < start - 1) i++;
  let j = i;
  for (; j < ranges.length && ranges[j][0] <= end + 1; j++) {
    const [lo, hi] = ranges[j];
    duplicate += Math.max(0, Math.min(hi, end) - Math.max(lo, start) + 1);
    from = Math.min(from, lo);
    to = Math.max(to, hi);
  }
  ranges.splice(i, j - i, [from, to]);
  return duplicate;
}

const hudName = name => name.replace(/^mcp__hud__/, '');
const isHud = name => /^mcp__hud__|^hud_/.test(name);
function waitKind(name, a) {
  if (hudName(name) === 'hud_read' || name === 'TaskOutput') return 'status-candidate';
  if (['wait', 'wait_agent', 'sleep', 'hud_wait'].includes(hudName(name)) || (hudName(name) === 'hud_sonic' && !a?.task)) return 'wait';
  if (hudName(name) === 'hud_peek') return 'hud-status';
  const command = a?.command ?? a?.cmd ?? a?.CommandLine;
  if (typeof command === 'string' && (/^\s*sleep\s+\d/.test(command) || /\bhud\s+watch\b/.test(command)
    || (/\.(?:output|status)\b|\/tmp\/claude-/.test(command) && /\b(?:tail|head|cat|stat|wc)\b/.test(command)))) return 'shell-poll';
}

function analyzer(harness, digest) {
  const turns = [], toolCalls = [], fileReads = [], injectedBlocks = [], compactions = [];
  const callIds = new Map(), repeats = new Set(), injections = new Set(), files = new Map(), changes = new Set(), stats = new Map();
  let cwd, segment = 0, turn, unmatchedResults = 0, duplicateChanges = 0, changeCount = 0;
  const setCwd = dir => { if (typeof dir === 'string' && path.isAbsolute(dir)) cwd = dir; };
  function newTurn(u) {
    turn = { index: turns.length + 1, segment };
    turns.push(turn);
    if (u) turn.usage = u;
    return turn;
  }
  function compact(fields = {}) {
    compactions.push({ afterTurn: turns.length, ...fields });
    segment++;
  }
  function inject(kind, text) {
    if (typeof text !== 'string' || !text) return;
    const key = digest(`${kind}\0${text}`);
    injectedBlocks.push({ afterTurn: turns.length, kind, bytes: bytes(text), repeat: injections.has(key) });
    injections.add(key);
  }
  function call({ id, name, args, callCwd }, at = turn) {
    if (id != null && callIds.has(id)) return;
    if (typeof name !== 'string' || !name) return;
    const rawName = name;
    name = /^[\w.:-]+$/.test(name) ? redactIds(name) : '<unknown-tool>';
    const argsDigest = digest(canonical(args ?? {}));
    const repeatKey = `${rawName}:${argsDigest}`;
    const item = { index: toolCalls.length + 1, turn: (at ?? newTurn()).index, name, argsDigest, resultBytes: null,
      repeat: repeats.has(repeatKey) };
    repeats.add(repeatKey);
    const read = readArgs(rawName, args, callCwd ?? cwd);
    if (read) {
      if (!files.has(read.file)) files.set(read.file, files.size + 1);
      const entry = { call: item.index, file: displayFile(read.file), fileIndex: files.get(read.file), requestedStart: read.start,
        requestedEnd: read.end ?? null, wholeRequested: read.wholeRequested, start: null, end: null, duplicatedLines: null };
      fileReads.push(entry);
      item.read = entry;
    }
    const waiting = waitKind(rawName, args);
    const state = { item, read, hud: isHud(rawName), statusReads: hudName(rawName) === 'hud_read' };
    if (waiting && waiting !== 'status-candidate') item.wait = waiting;
    if (hudName(rawName) === 'TaskOutput') item.wait = 'task-output';
    if (id != null) callIds.set(id, state);
    toolCalls.push(item);
    return state;
  }
  function result(id, value, { error, range, plain, hudBody } = {}) {
    const state = callIds.get(id);
    if (!state) { unmatchedResults++; return; }
    const { item, read } = state;
    if (item.resultBytes !== null) return;
    item.resultBytes = payloadBytes(value);
    const texts = textParts(value);
    if (state.hud) {
      for (const body of hudBody !== undefined ? [json(hudBody)] : typeof value === 'object' && !Array.isArray(value) ? [value] : texts.map(json)) {
        for (const change of list(body?.changes)) {
          const key = digest(canonical(change));
          changeCount++;
          if (changes.has(key)) duplicateChanges++;
          changes.add(key);
        }
        if (state.statusReads && body && typeof body === 'object' && !Array.isArray(body) && !error && !body.error && !('report' in body || 'digest' in body)) item.wait = 'hud-status';
      }
    }
    if (!read || error) return;
    if (!range && harness === 'claude' && !read.shell) range = numberedRange(texts[0] ?? '');
    if (!range && typeof plain === 'string') {
      const n = lineCount(plain);
      if (n > 0) range = [read.start, read.start + n - 1];
    }
    if (!range || !integer(range[0]) || range[0] < read.start || !integer(range[1]) || range[1] < range[0]) return;
    const start = range[0], end = Math.min(range[1], read.end ?? range[1]);
    if (end < start) return;
    Object.assign(item.read, { start, end });
  }
  function snapshot(coverage) {
    const ranges = Array.from({ length: files.size + 1 }, () => []);
    for (const r of fileReads) {
      if (r.start !== null) r.duplicatedLines = addRange(ranges[r.fileIndex], r.start, r.end);
    }
    let previous;
    for (const t of turns) {
      const context = t.usage?.contextTokens;
      if (previous?.segment === t.segment && context !== undefined && previous.usage?.contextTokens !== undefined) {
        t.contextDeltaTokens = context - previous.usage.contextTokens;
      }
      previous = t;
    }
    const waitingTurns = new Set();
    for (const c of toolCalls) {
      if (c.wait) waitingTurns.add(c.turn);
      const s = stats.get(c.name) ?? { name: c.name, calls: 0, paired: 0, resultBytes: 0, repeats: 0 };
      s.calls++;
      if (c.resultBytes !== null) { s.paired++; s.resultBytes += c.resultBytes; }
      if (c.repeat) s.repeats++;
      stats.set(c.name, s);
      delete c.read;
    }
    return { harness, turns, toolCalls, fileReads, injectedBlocks, compactions,
      tools: [...stats.values()].sort((a, b) => b.resultBytes - a.resultBytes),
      hud: { calls: toolCalls.filter(c => isHud(c.name)).length,
        notifications: injectedBlocks.filter(b => b.kind === 'hud-notification').length, changes: changeCount, duplicateChanges },
      waitingTurns: [...waitingTurns].sort((a, b) => a - b), coverage: { ...coverage, unmatchedResults } };
  }
  return { setCwd, newTurn, compact, inject, call, result, snapshot,
    get turn() { return turn; }, get segment() { return segment; } };
}

function tags(a, text) {
  let found = false;
  for (const [block, tag] of text.matchAll(/<(task-notification|system-reminder)>[\s\S]*?<\/\1>/g)) {
    const kind = tag === 'task-notification' && /<task-id>\s*j[0-9a-f]{16}\s*<\/task-id>/i.test(block) ? 'hud-notification' : tag;
    a.inject(kind, block);
    found = true;
  }
  return found;
}

function claude(a) {
  const messages = new Map(), uuids = new Set(), queued = new Set();
  return row => {
    a.setCwd(row.cwd);
    const m = row.message, c = m?.content;
    if (row.type === 'system' && row.subtype === 'compact_boundary') {
      const v = row.compactMetadata;
      a.compact({ preTokens: finite(v?.preTokens), postTokens: finite(v?.postTokens) });
    } else if (row.type === 'attachment') {
      const att = row.attachment;
      const rendered = typeof row.rendered === 'string' ? [row.rendered] : list(row.rendered).flatMap(part => textParts(part?.content ?? [part]));
      const text = rendered.join('\n');
      if (att?.type === 'queued_command') {
        if (queued.has(att.source_uuid) || uuids.has(att.source_uuid)) return;
        if (att.source_uuid) queued.add(att.source_uuid);
        for (const part of att.prompt == null ? rendered : textParts(att.prompt)) tags(a, part);
      } else if (!tags(a, text)) {
        const kind = /^[a-z_]+$/.test(att?.type ?? '') ? `attachment:${att.type}` : 'attachment';
        a.inject(kind, text);
      }
    } else if (row.type === 'assistant' && m) {
      const u = claudeUsage(m.usage ?? {});
      const key = m.id ?? row.requestId;
      let turn = key && messages.get(key);
      if (!turn && m.model !== '<synthetic>') {
        turn = a.newTurn(u);
        if (key) messages.set(key, turn);
      } else if (turn && u) {
        turn.usage = { ...turn.usage, ...u };
      }
      for (const b of list(c)) if (b.type === 'tool_use') a.call({ id: b.id, name: b.name, args: b.input }, turn);
    } else if (row.type === 'user' && m) {
      if (row.uuid && uuids.has(row.uuid)) return;
      if (row.uuid) uuids.add(row.uuid);
      if (row.isCompactSummary) a.inject('compaction-summary', textParts(c).join('\n'));
      else if (!queued.has(row.uuid)) for (const text of textParts(c)) tags(a, text);
      for (const b of list(c)) if (b.type === 'tool_result') {
        const f = row.toolUseResult?.file;
        const first = integer(f?.startLine), n = integer(f?.numLines);
        const range = first && n ? [first, first + n - 1] : undefined;
        const shell = row.toolUseResult;
        a.result(b.tool_use_id, b.content, { error: b.is_error, range, plain: shell?.interrupted ? undefined : shell?.stdout });
      }
    }
  };
}

function codexUsage(u = {}) {
  return usage({ contextTokens: u.input_tokens, inputTokens: u.input_tokens, cacheReadTokens: u.cached_input_tokens,
    cacheWriteTokens: u.cache_write_input_tokens, outputTokens: u.output_tokens, thinkingTokens: u.reasoning_output_tokens });
}
function codex(a) {
  const nativeTurns = new Map(), responseIds = new Set(), compactIds = new Set();
  const requests = new Map();
  let current, lastTotals;
  function select(id) {
    if (!id) return current ??= a.turn ?? a.newTurn();
    if (!nativeTurns.has(id)) nativeTurns.set(id, a.newTurn());
    return current = nativeTurns.get(id);
  }
  function record(turn, u, modern) {
    if (!u) return;
    const r = requests.get(turn) ?? { modern: [], legacy: [] };
    (modern ? r.modern : r.legacy).push({ usage: u, segment: a.segment });
    requests.set(turn, r);
  }
  return {
    row(row) {
      const p = row.payload ?? {};
      if (row.type === 'session_meta' || row.type === 'turn_context') a.setCwd(p.cwd);
      if (row.type === 'session_meta') a.inject('base-instructions', p.base_instructions?.text ?? p.base_instructions);
      else if (row.type === 'turn_context') select(p.turn_id);
      else if (row.type === 'world_state') {
        for (const key of ['agents_md', 'managed_developer_instructions', 'skills', 'host_skills', 'apps_instructions', 'environments_instructions', 'tools', 'plugins_instructions']) {
          if (p.state?.[key] != null) a.inject(`world-state:${key}`, canonical(p.state[key]));
        }
      } else if (row.type === 'token_usage_record') {
        if (p.response_id && responseIds.has(p.response_id)) return;
        if (p.response_id) responseIds.add(p.response_id);
        record(select(p.turn_id), codexUsage(p.usage ?? {}), true);
      } else if (row.type === 'event_msg') {
        if (p.type === 'task_started' || p.type === 'task_complete' || p.type === 'turn_aborted') select(p.turn_id);
        else if (p.type === 'token_count' && p.info?.last_token_usage) {
          const totals = p.info.total_token_usage && canonical(p.info.total_token_usage);
          if (totals && totals === lastTotals) return;
          lastTotals = totals;
          record(select(p.turn_id), codexUsage(p.info.last_token_usage), false);
        } else if (p.type === 'context_compacted' || (p.type === 'item_completed' && p.item?.type === 'ContextCompaction')) {
          if (p.item?.id && compactIds.has(p.item.id)) return;
          if (p.item?.id) compactIds.add(p.item.id);
          a.compact();
        }
      } else if (row.type === 'response_item') {
        if (p.type === 'function_call' || p.type === 'custom_tool_call') {
          const args = p.type === 'function_call' ? json(p.arguments) : p.input;
          a.call({ id: p.call_id, name: p.name, args }, select(p.turn_id));
        } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
          const text = textParts(p.output)[0];
          // Only simple successful exec_command envelopes expose a trustworthy plain-text boundary.
          const plain = /^Chunk ID:[^\n]*\nWall time:[^\n]*\nProcess exited with code 0\n(?:Original token count:[^\n]*\n)?(?:Final output|Output):\n([\s\S]*)$/.exec(text ?? '')?.[1];
          a.result(p.call_id, p.output, { plain });
        } else if (p.type === 'message') {
          for (const text of textParts(p.content)) {
            if (p.role === 'developer' || p.role === 'system') a.inject(`codex-${p.role}`, text);
            else if (p.role === 'user') tags(a, text);
          }
        } else if (p.type === 'additional_tools') a.inject('additional-tools', canonical(p.tools ?? []));
      }
    },
    finish() {
      for (const [turn, { modern, legacy }] of requests) {
        const selected = modern.length ? modern : legacy;
        turn.requests = selected.map(r => r.usage);
        turn.usage = turn.requests.at(-1);
        turn.segment = selected.at(-1).segment;
      }
    }
  };
}

function piUsage(u = {}) {
  return usage({ inputTokens: u.input, outputTokens: u.output, cacheReadTokens: u.cacheRead, cacheWriteTokens: u.cacheWrite,
    thinkingTokens: u.reasoning, contextTokens: sum(u.input, u.cacheRead, u.cacheWrite), costUsd: u.cost?.total });
}
function pi(a) {
  const ids = new Set();
  return row => {
    if (row.id && ids.has(row.id)) return;
    if (row.id) ids.add(row.id);
    const m = row.message ?? {};
    if (row.type === 'session') a.setCwd(row.cwd);
    else if (row.type === 'compaction') {
      a.compact({ preTokens: finite(row.tokensBefore), usage: piUsage(row.usage ?? {}) });
      a.inject('compaction-summary', row.summary);
    } else if (row.type === 'custom_message') {
      const kind = ['hud-sonic-ready', 'hud-orchestrator-answer'].includes(row.customType) ? 'hud-notification' : 'pi-custom-message';
      for (const text of textParts(row.content)) if (!tags(a, text)) a.inject(kind, text);
    } else if (row.type === 'message') {
      if (m.role === 'assistant') {
        const turn = a.newTurn(piUsage(m.usage ?? {}));
        for (const b of list(m.content)) if (b.type === 'toolCall') a.call({ id: b.id, name: b.name, args: b.arguments }, turn);
      } else if (m.role === 'toolResult') {
        let plain;
        if (m.toolName === 'read' && textParts(m.content).length === 1) {
          const text = textParts(m.content)[0];
          // Drop the native notice, not source lines. Byte-only or partial-long-line reads remain unknown.
          if (!/\[(?:First line|Output truncated)|\bshowing bytes\b/i.test(text)) {
            plain = text.replace(/\n\n\[(?:Showing lines [^\]\n]*?\. )?[^\]\n]*more lines in file\. Use offset=\d+ to continue\.\]\s*$/i, '');
          }
        }
        a.result(m.toolCallId, m.content, { error: m.isError, plain });
      } else if (m.role === 'system') {
        if (m.sections && Object.keys(m.sections).length) {
          for (const section of Object.values(m.sections)) if (section != null) a.inject('pi-system-section', typeof section === 'string' ? section : canonical(section));
        } else for (const text of textParts(m.content)) a.inject('pi-system', text);
        if (list(m.toolsAdded).length) a.inject('pi-tools-added', canonical(m.toolsAdded));
      } else if (m.role === 'user') for (const text of textParts(m.content)) tags(a, text);
    }
  };
}

function agy(a) {
  let pending = [], next = 0, id = 0;
  return row => {
    if (row.type === 'PLANNER_RESPONSE') {
      const turn = a.newTurn(usage({ inputTokens: row.input_tokens, cacheReadTokens: row.cache_read_tokens,
        outputTokens: row.output_tokens, contextTokens: sum(row.input_tokens, row.cache_read_tokens) }));
      pending = [];
      next = 0;
      for (const tool of list(row.tool_calls)) {
        const args = tool.args;
        const mcp = tool.name === 'call_mcp_tool' && args?.ServerName === 'hud' && typeof args.ToolName === 'string';
        const name = mcp ? `mcp__hud__${args.ToolName}` : tool.name;
        pending.push(a.call({ id: ++id, name, args: mcp ? args.Arguments : args }, turn) ? id : undefined);
      }
    } else if (row.type === 'GENERIC') {
      const body = row.content;
      const range = typeof body === 'string' && /(?:^|\n)(?:Showing lines |Partial read \(lines )(\d+)-(\d+) of \d+/.exec(body);
      const hudBody = typeof body === 'string' ? body.replace(/^(?:(?:Created|Completed) At:[^\n]*\n){1,4}\s*/, '') : undefined;
      const value = list(row.media).length ? [body ?? '', ...row.media] : body;
      a.result(pending[next++], value, { error: row.status === 'ERROR' || !!row.error, range: range ? [+range[1], +range[2]] : undefined, hudBody });
    } else if ((row.type === 'SYSTEM_MESSAGE' || row.type === 'USER_INPUT') && typeof row.content === 'string') {
      const text = row.content;
      if (text.startsWith('[HUD job events]')) a.inject('hud-notification', text);
      else if (row.type === 'SYSTEM_MESSAGE' && text.includes('Reminder: work efficiently')) a.inject('agy-efficiency-reminder', text);
      else if (row.type === 'SYSTEM_MESSAGE') a.inject('agy-system', text);
    }
  };
}

const adapters = { claude, codex, pi, agy };
const recordTypes = {
  claude: new Set(['assistant', 'user', 'system', 'attachment']),
  codex: new Set(['session_meta', 'turn_context', 'event_msg', 'response_item', 'token_usage_record', 'world_state']),
  pi: new Set(['session', 'message', 'custom_message', 'compaction']),
  agy: new Set(['PLANNER_RESPONSE', 'GENERIC', 'USER_INPUT', 'SYSTEM_MESSAGE'])
};

class InputError extends Error {}
const agentHome = {
  claude: path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')),
  pi: path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(home, '.pi', 'agent')),
  agy: path.join(home, '.gemini', 'antigravity-cli'),
  hud: path.resolve(process.env.HUD_HOME || path.join(home, '.hud'))
};
const codexHomes = [...new Set([process.env.CODEX_HOME, path.join(home, '.codex'), path.join(home, '.codex-account2')].filter(Boolean).map(dir => path.resolve(dir)))];

async function matchingFiles(dir, matches, depth) {
  let files;
  try { files = await readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const found = [];
  for (const entry of files) {
    const file = path.join(dir, entry.name);
    if (entry.isFile() && matches(entry.name)) found.push(file);
    else if (depth && entry.isDirectory()) found.push(...await matchingFiles(file, matches, depth - 1));
  }
  return found;
}
async function jobTranscript(harness, id) {
  if (!jobId.test(id)) throw new InputError('Expected a HUD job ID after --job.');
  const dir = path.join(agentHome.hud, 'jobs', id);
  const status = JSON.parse(await readFile(path.join(dir, 'STATUS.json'), 'utf8'));
  const agent = status.harness === 'pi' ? 'pi' : status.agent;
  if (agent && agent !== harness) throw new InputError('The HUD job belongs to a different harness.');
  if (typeof status.session_file === 'string' && path.isAbsolute(status.session_file)) {
    try { if ((await stat(status.session_file)).isFile()) return status.session_file; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const native = status.agent_session_id ?? status.session_id;
  if (typeof native !== 'string' || !/^[\w-]+$/.test(native)) throw new InputError('The job has no native session ID; pass its transcript explicitly.');
  let found;
  if (harness === 'agy') {
    const file = path.join(agentHome.agy, 'brain', native, '.system_generated', 'logs', 'transcript_full.jsonl');
    if ((await stat(file)).isFile()) return file;
    found = [];
  } else if (harness === 'claude') {
    found = await matchingFiles(path.join(agentHome.claude, 'projects'), name => name === `${native}.jsonl`, 1);
  } else if (harness === 'pi') {
    found = await matchingFiles(path.join(agentHome.pi, 'sessions'), name => name.endsWith(`_${native}.jsonl`) || name === `${native}.jsonl`, 1);
  } else {
    found = [];
    for (const dir of codexHomes) {
      found.push(...await matchingFiles(path.join(dir, 'sessions'), name => name.endsWith(`-${native}.jsonl`), 3));
    }
  }
  if (found.length !== 1) throw new InputError(found.length ? 'Multiple native transcripts match this job; pass one explicitly.' : 'No native transcript matches this job.');
  return found[0];
}

async function extract(harness, file, digest) {
  const info = await stat(file);
  if (!info.isFile()) throw new InputError('Each transcript path must name a regular file.');
  const a = analyzer(harness, digest);
  const adapter = adapters[harness](a);
  let rows = 0, invalidRows = 0, recognizedRows = 0;
  if (info.size) {
    const stream = createReadStream(file, { end: info.size - 1 });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      rows++;
      const row = json(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) { invalidRows++; continue; }
      if (recordTypes[harness].has(row.type)) recognizedRows++;
      (adapter.row ?? adapter)(row);
    }
  }
  adapter.finish?.();
  if (!recognizedRows) throw new InputError('No recognized rows for the selected harness.');
  return a.snapshot({ rows, invalidRows, recognizedRows, compactionMarkers: harness !== 'agy' });
}

function summary(s, i) {
  const resultBytes = s.tools.reduce((total, tool) => total + tool.resultBytes, 0);
  const paired = s.tools.reduce((total, tool) => total + tool.paired, 0);
  const repeats = s.toolCalls.filter(c => c.repeat).length;
  const observed = s.fileReads.filter(read => read.duplicatedLines !== null);
  const duplicateLines = observed.reduce((n, read) => n + read.duplicatedLines, 0);
  const injectionRepeats = s.injectedBlocks.filter(b => b.repeat).length;
  const withUsage = s.turns.filter(t => t.usage).length;
  const priced = s.turns.filter(t => t.usage?.costUsd !== undefined);
  const cost = priced.length ? `, $${priced.reduce((n, t) => n + t.usage.costUsd, 0).toFixed(6)} observed` : '';
  const top = s.tools.slice(0, 5).map(t => `${t.name} ${t.calls}/${t.resultBytes} B/${t.repeats} repeats`).join('; ');
  const compactions = s.coverage.compactionMarkers ? s.compactions.length : 'unknown (no verified marker)';
  return `Session ${i} (${s.harness}): ${s.turns.length} turns, ${s.toolCalls.length} calls (${paired} paired), ${resultBytes} result bytes, ${repeats} repeat calls.\n`
    + `Read ranges: ${observed.length}/${s.fileReads.length} verified, ${observed.length ? duplicateLines : 'unknown'} duplicate lines. Injections: ${s.injectedBlocks.length} (${injectionRepeats} repeats).\n`
    + `HUD: ${s.hud.calls} calls, ${s.hud.notifications} notifications, ${s.hud.changes} changes (${s.hud.duplicateChanges} duplicates). Waiting candidates: ${s.waitingTurns.length} turns.\n`
    + `Compactions: ${compactions}. Usage: ${withUsage}/${s.turns.length} turns, priced: ${priced.length}/${s.turns.length}${cost}. Invalid rows: ${s.coverage.invalidRows}/${s.coverage.rows}; unmatched results: ${s.coverage.unmatchedResults}.\n`
    + (top ? `Top tools (calls/result bytes/repeats): ${top}\n` : '');
}

async function effectivePath(dir) {
  try { return await realpath(dir); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return path.join(await effectivePath(path.dirname(dir)), path.basename(dir));
  }
}

async function main(argv) {
  const [harness, ...rest] = argv;
  if (!Object.hasOwn(adapters, harness)) throw new InputError('Usage: node extract.mjs <claude|codex|pi|agy> <paths...> [--job <id>] [--out dir]');
  const sources = [];
  let parent = path.join(repo, 'tmp', 'tasks', 'TRACE-REVIEW');
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--out' || arg === '--job') {
      const value = rest[++i];
      if (!value || value.startsWith('--')) throw new InputError('Missing value for --out or --job.');
      if (arg === '--out') parent = path.resolve(value);
      else sources.push(await jobTranscript(harness, value));
    } else if (arg.startsWith('--')) throw new InputError('Unrecognized option.');
    else sources.push(path.resolve(arg));
  }
  if (!sources.length) throw new InputError('Supply at least one transcript path or --job.');
  parent = await effectivePath(parent);
  const stores = await Promise.all([...Object.values(agentHome), ...codexHomes].map(effectivePath));
  if (stores.some(root => within(root, parent))) throw new InputError('Use an output directory outside the record stores.');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const output = await mkdtemp(path.join(parent, 'run-'));
  const key = randomBytes(32);
  const digest = text => createHmac('sha256', key).update(text).digest('hex');
  const text = [], jsonFile = path.join(output, 'metrics.partial');
  const handle = await open(jsonFile, 'wx', 0o600);
  try {
    await handle.writeFile('{"schemaVersion":1,"sessions":[\n');
    for (const file of new Set(sources)) {
      const session = await extract(harness, file, digest);
      const i = text.length + 1;
      await handle.writeFile((i === 1 ? '' : ',\n') + JSON.stringify(session));
      text.push(summary(session, i));
    }
    await handle.writeFile('\n]}\n');
  } finally {
    await handle.close();
  }
  const short = text.join('\n');
  const summaryFile = path.join(output, 'summary.partial');
  const summaryHandle = await open(summaryFile, 'wx', 0o600);
  try { await summaryHandle.writeFile(short); } finally { await summaryHandle.close(); }
  await rename(jsonFile, path.join(output, 'metrics.json'));
  await rename(summaryFile, path.join(output, 'summary.txt'));
  console.log(`Output: ${path.relative(process.cwd(), output) || '.'}\n${short.trimEnd()}`);
}

main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof InputError ? error.message : `Extraction failed${/^[A-Z_]+$/.test(error.code ?? '') ? ` (${error.code})` : ''}.`);
  process.exitCode = 1;
});
