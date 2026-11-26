import * as fs from 'node:fs';
import { join } from 'node:path';
import { batchActive, batchEvents, isBatchId, type Batch } from '../mcp/batch-state.js';
import { activeLand, isFlowId, landFile, landNoticeLine, readLand } from '../mcp/land-state.js';
import { isTicketQueueId, ticketQueueNotice, type TicketQueue } from '../mcp/ticket-queue-state.js';
import { activeTicketEdit, isTicketEditId, type TicketEdit } from '../mcp/ticket-edit-state.js';
import { sharedRoot } from '../roles/projects.js';
import { isComposedId, type ComposedRun } from './composed-state.js';
import { workflowHeaders, type HeaderPass } from './header-scan.js';
import { runVisible } from './scope.js';
import { noticeEvents } from './store.js';

function ticketEditEvent(home: string, pane: string | null, all: boolean, cwd: string, pass: HeaderPass, file: string) {
  const path = join(home, 'flows', file);
  if (fs.existsSync(`${path}.${all ? 'observed' : 'noticed'}`)) return;
  const row = pass.header<TicketEdit>(file);
  if (!row || (!all && (row.pane !== pane || (!pane && row.origin !== cwd)))) return;
  if (activeTicketEdit(row)) return { pending: true, events: [] };
  const outcome = row.state === 'failed' ? 'failed' : 'completed';
  const line = `Ticket ${row.op} ${outcome} — hud_read({job: "${row.receipt}"})`;
  const events = noticeEvents(home, { flow: row.receipt, notices: { 'end-0': line } }, all, path);
  // Admission may prune a settled receipt between the scan and its notice claim.
  if (!fs.existsSync(path)) for (const { marker } of events) fs.rmSync(marker, { force: true });
  return { pending: false, events };
}

export function taskNoticeSource(home: string, pane: string | null, cwd: string) {
  const dir = join(home, 'flows');
  let previous: string | undefined;
  return () => {
    // Task clients already have a quiet timer. Only list flows when an atomic
    // receipt replacement or a notice claim/release actually changed the directory.
    const st = fs.statSync(dir, { bigint: true, throwIfNoEntry: false });
    const stamp = st && `${st.dev}:${st.ino}:${st.mtimeNs}:${st.ctimeNs}`;
    if (!stamp || stamp === previous) return [];
    const pass = workflowHeaders(home);
    const events = pass.files.flatMap(file => {
      if (!file.endsWith('.json')) return [];
      const id = file.slice(0, -5);
      if (isTicketEditId(id)) return ticketEditEvent(home, pane, false, cwd, pass, file)?.events ?? [];
      if (!isComposedId(id)) return [];
      const run = pass.header<ComposedRun>(file);
      return run?.template === 'composed' && runVisible(run, pane, cwd) ? noticeEvents(home, run) : [];
    });
    previous = stamp;
    return events;
  };
}

/** Scan active runs and unclaimed terminal results. Quiet passes only parse a
 * changed header; previously claimed land/queue results don't even need a stat. */
export function workflowEvents(home: string, pane: string | null, all = false, cwd = process.cwd(), modCatchup = false) {
  const lines: string[] = [];
  let pending = false;
  const pass = workflowHeaders(home);
  for (const file of pass.files) {
    const sidecar = /^(.*)\.json\.gate-[1-9]\d*(?:-rerun)?\.log$/.exec(file);
    if (sidecar && isFlowId(sidecar[1])) {
      try {
        if (!fs.lstatSync(landFile(home, sidecar[1]), { throwIfNoEntry: false })) fs.unlinkSync(join(home, 'flows', file));
      } catch { /* Retry at the next scan. */ }
      continue;
    }
    if (!file.endsWith('.json')) continue;
    const id = file.slice(0, -5);
    if (isTicketEditId(id)) {
      const result = ticketEditEvent(home, pane, all, cwd, pass, file);
      if (result) { pending ||= result.pending; lines.push(...result.events.map(e => e.line)); }
      continue;
    }
    if (isComposedId(id)) {
      const run = pass.header<ComposedRun>(file);
      if (run?.template === 'composed' && (all || runVisible(run, pane, cwd))) {
        lines.push(...noticeEvents(home, run, all).map(e => e.line));
        pending ||= run.state === 'working';
      }
      continue;
    }
    if (isBatchId(id)) {
      const b = pass.header<Batch>(file);
      if (b && (all || runVisible(b, pane, cwd))) {
        lines.push(...batchEvents(home, b, all).map(event => event.line));
        pending ||= batchActive(b);
      }
      continue;
    }
    const land = isFlowId(id);
    if (!land && !isTicketQueueId(id)) continue;
    const path = landFile(home, id);
    if (fs.existsSync(`${path}.${all ? 'observed' : 'noticed'}`)) continue;
    if (land) {
      const f = readLand(home, id, pass);
      if (!f?.wt || f.task || f.ticket_queue || (!all && f.pane !== pane)) continue;
      // Cross-project lands report to their authorizing pane; pane-less watches stay project-scoped.
      if (!all && !pane && f.wt.main_root !== cwd && f.wt.main_root !== sharedRoot(cwd)) continue;
      if (activeLand(f)) { pending = true; continue; }
      // Old receipts and new outboxes share the historical end marker (also across rollback).
      const outbox = f.workflow ?? { flow: id, notices: { 'end-0': landNoticeLine(f) } };
      const events = noticeEvents(home, outbox, all, path);
      if (!modCatchup || f.state === 'failed') lines.push(...events.map(e => e.line));
    } else {
      const q = pass.header<TicketQueue>(file);
      if (!q || q.task || (!all && !runVisible(q, pane, cwd))) continue;
      if (q.state === 'working') { pending = true; continue; }
      const outbox = q.template && q.notices !== undefined
        ? { flow: id, notices: q.notices }
        : q.notices && Object.keys(q.notices).length ? { flow: id, notices: q.notices }
        : { flow: id, notices: { 'end-0': ticketQueueNotice(q).replace(/\r?\n/g, ' | ') } };
      lines.push(...noticeEvents(home, outbox, all, path).map(e => e.line));
    }
  }
  return { lines, pending };
}
