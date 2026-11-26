import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { worktreeGit } from '../collectors/worktrees.js';
import { takeLease } from '../roles/lease.js';
import { sharedRoot } from '../roles/projects.js';
import { tryAbstractLock, withAbstractLock } from '../utils/abstract-lock.js';
import { readDirSafe } from '../utils/atomic-fs.js';
import { editLocalTickets } from './local-tickets.js';
import { binScript } from './paths.js';
import { keyLock } from './store/key-lock.js';
import { applyTicketEdits, ticketCheckout, ticketEditMarker, ticketLease } from './ticket-commits.js';
import {
  activeTicketEdit, isTicketEditId, pruneTicketEdit, readTicketEdit, saveTicketEdit, ticketEditView, type TicketEdit,
} from './ticket-edit-state.js';

const MAX_PENDING = 64;
const MAX_RECEIPTS = 128;
const MAX_REQUEST_BYTES = 128 * 1024;
const leaseName = 'main-checkout';

function receipts(home: string) {
  // The sequence prefix is allocated under the admission mutex, not by a wall clock.
  return readDirSafe(join(home, 'flows')).filter(file => file.endsWith('.json') && isTicketEditId(file.slice(0, -5)))
    .sort().flatMap(file => readTicketEdit(home, file.slice(0, -5)) ?? []);
}

function wake(home: string, project: string) {
  // Apply under a helper's lease, not the MCP's. Reload or loss of the connection
  // cannot interrupt a commit or release the checkout while Git is still running.
  const child = spawn(process.execPath, [binScript('workflow-runner'), '--ticket-edits', project], {
    detached: true, stdio: 'ignore', env: { ...process.env, HUD_HOME: home },
  });
  child.once('error', () => { /* The next MCP start or submission recovers the receipt. */ }).unref();
}

export function resumeTicketEdits(home: string) {
  for (const project of new Set(receipts(home).filter(activeTicketEdit).map(row => row.project))) wake(home, project);
}

export function readTicketEditReceipt(home: string, id: string) {
  const row = readTicketEdit(home, id);
  if (!row) return { ok: false, code: 'receipt_not_found' };
  return ticketEditView(row);
}

export async function submitTicketEdit(cwd: string, args: Record<string, unknown>, home: string, pane: string | null) {
  const { op } = args;
  if (op !== 'add' && op !== 'update') throw Error('invalid_arguments: op');
  cwd = fs.realpathSync(cwd);
  const apply = (root: string, git: boolean) => applyTicketEdits(root, git, op, edits => editLocalTickets(cwd, args, home, op, edits));
  const checkout = await ticketCheckout(cwd);
  if (!checkout) return keyLock(`tickets:${cwd}`, () => apply(cwd, false));

  const project = sharedRoot(checkout), lease = ticketLease(checkout, home);
  const quick = AbortSignal.timeout(250);
  const grant = await takeLease({ name: leaseName, wait_s: 0 }, lease, quick).catch(async error => {
    if (error !== quick.reason) throw error;
    // A stale land custodian can take longer than an ordinary try. Let the
    // helper wait for it. Release in case the timeout raced the lease publish.
    await takeLease({ name: leaseName, release: true }, lease);
  });
  const acquired = grant && 'granted' in grant && grant.granted;
  let row: TicketEdit | undefined;
  try {
    row = await withAbstractLock('ticket-edit-admit', fs.realpathSync(home), () => {
      const rows = receipts(home), pending = rows.filter(activeTicketEdit);
      if (acquired && !pending.some(row => row.project === project)) return;
      if (pending.length >= MAX_PENDING) throw Error('Ticket edit queue is full; try again after receipts settle');
      if (Buffer.byteLength(JSON.stringify(args)) > MAX_REQUEST_BYTES) throw Error('Ticket edit is too large to queue');
      const seq = rows.length ? BigInt(`0x${rows.at(-1)!.receipt.slice(2, 18)}`) + 1n : 1n;
      for (const old of rows.filter(row => !activeTicketEdit(row)).slice(0, Math.max(0, rows.length - MAX_RECEIPTS + 1)))
        pruneTicketEdit(home, old.receipt);
      const queued: TicketEdit = { receipt: `te${seq.toString(16).padStart(16, '0')}${randomBytes(8).toString('hex')}`,
        cwd, checkout, project, pane, origin: process.cwd(), op, state: 'queued', args };
      saveTicketEdit(home, queued);
      return queued;
    });
    if (!row) return await apply(checkout, true);
  } finally {
    if (acquired) await takeLease({ name: leaseName, release: true }, lease);
  }
  wake(home, project);
  return ticketEditView(row);
}

async function settle(home: string, entry: TicketEdit) {
  if (entry.state !== 'queued' && entry.state !== 'applying') return;
  const { state, receipt, cwd, checkout, project, pane, origin, op } = entry;
  const header = { receipt, cwd, checkout, project, pane, origin, op };
  const lease = ticketLease(project, home);
  let acquired = false;
  try {
    let terminal: TicketEdit;
    let plan = state === 'applying' ? entry.result : undefined;
    const committed = async () => !!plan && !!(await worktreeGit(checkout, ['log', '-1', '--format=%H', '--fixed-strings',
      `--grep=${ticketEditMarker(receipt)}`, 'HEAD']).catch(() => ''));
    try {
      while (!acquired) {
        const grant = await takeLease({ name: leaseName, wait_s: 300 }, lease);
        acquired = 'granted' in grant && grant.granted;
      }
      if (fs.realpathSync(cwd) !== cwd || await ticketCheckout(cwd) !== checkout || sharedRoot(checkout) !== project)
        throw Error('Ticket checkout moved or changed while the edit was queued');
      if (state === 'applying') {
        if (!await committed()) throw Error('Ticket edit was interrupted; inspect the checkout before retrying');
        terminal = { ...header, state: 'completed', result: entry.result };
      } else {
        const result = await applyTicketEdits(checkout, true, op, edits => editLocalTickets(cwd, entry.args, home, op, edits), {
          id: receipt,
          beforeWrite(result) {
            saveTicketEdit(home, { ...header, state: 'applying', result });
            plan = result;
          },
        });
        terminal = { ...header, state: 'completed', result };
      }
    } catch (e) {
      // If Git exited uncertainly after committing, keep the outcome, not a retry.
      terminal = state === 'queued' && acquired && plan && await committed() ? { ...header, state: 'completed', result: plan }
        : { ...header, state: 'failed', error: e instanceof Error ? e.message : String(e) };
    }
    saveTicketEdit(home, terminal);
  } finally {
    if (acquired) await takeLease({ name: leaseName, release: true }, lease);
  }
}

/** One helper per project waits for the checkout; admission never waits for this mutex. */
export async function drainTicketEdits(home: string, project: string) {
  home = fs.realpathSync(home);
  const next = () => receipts(home).find(row => activeTicketEdit(row) && row.project === project);
  do {
    const release = await tryAbstractLock('ticket-edit-drain', `${home}\0${project}`);
    if (!release) return;
    try {
      for (let row; (row = next());) await settle(home, row);
    } finally { await release(); }
    // An admission could have lost its wake while we were releasing the mutex.
  } while (next());
}
