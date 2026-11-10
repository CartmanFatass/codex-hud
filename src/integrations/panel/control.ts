/** Short-lived display control; never an execution host, restart loop or job cleanup path. */
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { getHudHome, getHudDisplayHome } from '../../hud-home.js';
import { resolveHudEnv } from '../../utils/hud-env.js';
import { type NativePanelEvidence, panelEligibility, autoOpenEnabled, type ProcessLaunch } from './eligibility.js';
import { PanelDeadline, samePane, panelArgv, registeredProcess, type PanelHerdr } from './herdr.js';
import { readProcess, sameStamp } from '../../core/run/process.js';
import {
  PanelStore,
  panelKey,
  decodeReceipt,
  validateContext,
  readJson,
  saveJson,
  validPane,
  type PanelContext,
  type PanelReceipt,
  type PaneIdentity,
} from './receipt.js';
export type PanelOperation = 'open' | 'close' | 'toggle' | 'status';
export interface PanelControlOptions {
  env: NodeJS.ProcessEnv;
  herdr: PanelHerdr;
  /** Only an in-process harness adapter may supply this; never deserialize hook claims here. */
  native: NativePanelEvidence | null;
  /** A4/A5 must bind this to the native epoch whenever same-process session replacement is possible. */
  isCurrent?: () => boolean;
  automatic?: boolean;
  generation?: string;
  budgetMs?: number;
  processInfo?: typeof readProcess;
  processLaunch?: (pid: number) => ProcessLaunch | null;
  /** Process-image probe seam for synthetic processes. Production validates /proc argv AND token. */
  registered?: typeof registeredProcess;
}
export interface PanelResult {
  receipt: PanelReceipt | null;
  diagnostic: string;
  message?: string;
}
function splitLost(r: PanelReceipt): PanelResult {
  return {
    receipt: r,
    diagnostic: 'split_reply_lost',
    message: 'The split reply was lost; an empty pane may need manual closing. Use open explicitly to try again.',
  };
}
async function observeOwned(
  r: PanelReceipt,
  o: PanelControlOptions,
  pane: string,
  d: PanelDeadline,
  workspace = (r.panel?.pane === pane ? r.panel.workspace : undefined) ??
    (r.createdPane === pane ? r.createdWorkspace : undefined)
): Promise<PaneIdentity | null> {
  if ((await o.herdr.instance(d)) !== r.instance) throw new Error('herdr_instance_changed');
  const observed = await o.herdr.observe(pane, d, workspace);
  if ((await o.herdr.instance(d)) !== r.instance) throw new Error('herdr_instance_changed');
  if (observed === null && !workspace) throw new Error('panel_workspace_unknown');
  return observed;
}
/** Poll only the acknowledged pane; never re-split or run until its original shell is ready. */
async function awaitReady(s: PanelStore, r: PanelReceipt, o: PanelControlOptions, d: PanelDeadline): Promise<boolean> {
  while (d.remaining(Infinity) > 750) {
    if (o.isCurrent?.() === false) s.fence(r);
    let candidate: PaneIdentity | null;
    try {
      candidate = await observeOwned(r, o, r.createdPane!, d);
    } catch (error) {
      if (error instanceof Error && error.message === 'herdr_instance_changed') throw error;
      await pause(d);
      continue; // transient shell/process startup evidence
    }
    if (candidate === null) {
      r.phase = 'closed';
      s.write(r);
      return false;
    }
    if (!candidate.workspace) throw new Error('panel_workspace_unknown');
    if (
      (r.createdWorkspace && candidate.workspace !== r.createdWorkspace) ||
      (r.origin.workspace && candidate.workspace !== r.origin.workspace)
    )
      throw new Error('panel_workspace_changed');
    if (candidate.pane !== r.createdPane || candidate.tab !== r.origin.tab || candidate.pane === r.origin.pane)
      throw new Error('panel_split_unverified');
    if (
      r.panel &&
      (candidate.terminal !== r.panel.terminal ||
        candidate.workspace !== r.panel.workspace ||
        !sameStamp(candidate.shell ?? candidate.process, r.panel.shell ?? r.panel.process) ||
        (!candidate.atPrompt && !sameStamp(candidate.process, r.panel.process)))
    )
      throw new Error('panel_occupant_changed');
    r.panel = candidate;
    r.createdWorkspace = candidate.workspace;
    s.write(r);
    if (o.isCurrent?.() === false) s.fence(r);
    if (s.fenced(r)) {
      await closeRecorded(s, r, o, d);
      return false;
    }
    if (candidate.atPrompt) return true;
    await pause(d);
  }
  // The split ID remains recorded even if no trustworthy occupant ever appeared.
  // Close only a captured, freshly matching occupant; otherwise leave it uncertain.
  if (r.panel) await closeRecorded(s, r, o, d);
  else {
    r.phase = 'uncertain';
    s.write(r);
  }
  return false;
}
function sameTarget(a: PanelContext, b: PanelContext): boolean {
  return a.target.root === b.target.root && a.target.harness === b.target.harness;
}
async function pause(d: PanelDeadline): Promise<void> {
  await delay(Math.min(20, d.remaining()), undefined, { signal: d.signal });
}
async function locked<T>(s: PanelStore, key: string, d: PanelDeadline, body: () => Promise<T>): Promise<T> {
  const file = s.file(key, 'lock');
  const token = randomUUID();
  for (;;) {
    d.remaining(Infinity);
    try {
      saveJson(file, token, true);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    // Never steal an uncertain lock. A crashed controller cannot cause a second split.
    await pause(d);
  }
  try {
    return await body();
  } finally {
    if (readJson(file) === token) fs.unlinkSync(file);
  }
}
async function reconcile(s: PanelStore, r: PanelReceipt, o: PanelControlOptions, d: PanelDeadline): Promise<boolean> {
  const knownPane = r.createdPane ?? r.panel?.pane;
  if (knownPane && (await observeOwned(r, o, knownPane, d)) === null) {
    r.phase = 'closed';
    s.write(r);
    return false;
  }
  const raw = readJson(s.registration(r.token));
  if (raw === null) return false;
  const v = raw as { generation?: unknown; panel?: unknown };
  if (
    v.generation !== r.generation ||
    !validPane(v.panel) ||
    v.panel.pane === r.origin.pane ||
    v.panel.tab !== r.origin.tab ||
    (r.createdPane !== undefined && v.panel.pane !== r.createdPane) ||
    (r.panel !== null && (v.panel.terminal !== r.panel.terminal || v.panel.workspace !== r.panel.workspace)) ||
    !(o.registered ?? registeredProcess)(r, v.panel)
  )
    throw new Error('panel_registration_unverified');
  if ((await o.herdr.instance(d)) !== r.instance) throw new Error('herdr_instance_changed');
  const observed = await observeOwned(r, o, v.panel.pane, d, v.panel.workspace);
  if (!observed || !samePane(observed, v.panel)) throw new Error('panel_occupant_changed');
  r.panel = v.panel;
  if (!s.fenced(r)) r.phase = 'open';
  s.write(r);
  return true;
}
async function closeRecorded(
  s: PanelStore,
  r: PanelReceipt,
  o: PanelControlOptions,
  d: PanelDeadline,
  uncertain = false
): Promise<void> {
  s.fence(r);
  if (r.phase === 'closed') return;
  if (!r.panel) {
    r.phase = 'uncertain';
    s.write(r);
    return;
  }
  if (!r.panel.workspace) throw new Error('panel_workspace_unknown');
  r.phase = uncertain ? 'uncertain' : 'closing';
  s.write(r);
  if (r.panel.pane === r.origin.pane || r.panel.tab !== r.origin.tab || (await o.herdr.instance(d)) !== r.instance)
    throw new Error('panel_close_refused');
  const observed = await observeOwned(r, o, r.panel.pane, d);
  if (observed === null) {
    r.phase = 'closed';
    s.write(r);
    return;
  }
  if (!samePane(observed, r.panel)) throw new Error('panel_occupant_changed');
  if ((await o.herdr.instance(d)) !== r.instance) throw new Error('herdr_instance_changed');
  // Includes the initial shell for a launch that never registered. A reused foreground
  // process or terminal is never closed merely because it occupies the same pane ID.
  await o.herdr.close(r.panel.pane, d);
  r.phase = uncertain ? 'uncertain' : 'closed';
  s.write(r);
}
export async function controlPanel(
  operation: PanelOperation,
  c: PanelContext,
  o: PanelControlOptions
): Promise<PanelResult> {
  validateContext(c); // before files or transport effects
  if (!['open', 'close', 'toggle', 'status'].includes(operation)) throw new Error('panel_operation_invalid');
  const s = new PanelStore(o.env);
  const key = panelKey(c);
  const d = new PanelDeadline(Math.min(o.budgetMs ?? (operation === 'close' ? 900 : 4000), 4000));
  let receipt: PanelReceipt | null = null;
  const current = () => o.isCurrent?.() !== false;
  try {
    receipt = s.read(key);
    if (operation === 'status' && receipt?.reason === 'split_reply_lost') return splitLost(receipt);
    if (operation === 'status')
      return {
        receipt,
        diagnostic: receipt?.phase ?? (readJson(s.file(key, 'used')) === null ? 'closed' : 'panel_receipt_lost'),
      };
    // SessionEnd fences immediately, even while an opening controller holds the lock.
    if (operation === 'close' && receipt && sameTarget(receipt, c) && o.generation === receipt.generation)
      s.fence(receipt);
    return await locked(s, key, d, async () => {
      try {
        let r = s.read(key);
        receipt = r;
        if (!r && readJson(s.file(key, 'used')) !== null) return { receipt: null, diagnostic: 'panel_receipt_lost' };
        if (operation === 'close' || (operation === 'toggle' && r && sameTarget(r, c) && r.phase !== 'closed')) {
          if (!r || !sameTarget(r, c) || o.generation !== r.generation)
            return { receipt: r, diagnostic: 'panel_stale_generation' };
          if (r.phase === 'closed') return { receipt: r, diagnostic: 'closed' };
          if (r.reason === 'split_reply_lost') return splitLost(r);
          await reconcile(s, r, o, d);
          await closeRecorded(s, r, o, d);
          return { receipt: r, diagnostic: r.phase };
        }
        if (!current()) return { receipt: r, diagnostic: 'panel_stale_context' };
        if (o.automatic && !autoOpenEnabled(o.env)) return { receipt: r, diagnostic: 'panel_auto_open_disabled' };
        if (r?.reason === 'split_reply_lost' && o.automatic) return splitLost(r);
        if (r && sameTarget(r, c) && r.reason !== 'split_reply_lost') {
          if (r.phase === 'open') {
            const current = r.panel && (await observeOwned(r, o, r.panel.pane, d));
            if (current && r.panel && samePane(current, r.panel)) return { receipt: r, diagnostic: 'open' };
            if (current) throw new Error('panel_occupant_changed');
            r.phase = 'closed';
            s.write(r); // manual close/crash is not auto-resurrected
            if (o.automatic) return { receipt: r, diagnostic: 'panel_manually_closed' };
          }
          if (r.phase === 'opening' || r.phase === 'uncertain' || r.phase === 'closing') {
            await reconcile(s, r, o, d);
            if (s.fenced(r)) await closeRecorded(s, r, o, d);
            if ((r as PanelReceipt).phase !== 'closed' || o.automatic) return { receipt: r, diagnostic: r.phase }; // never replay a split/start
          }
          if (o.automatic && r.phase === 'closed') return { receipt: r, diagnostic: 'panel_manually_closed' };
        }
        const eligibility = await panelEligibility(c, o.herdr, d, o.native, o.processLaunch, o.processInfo);
        if (!eligibility.eligible) return { receipt: r, diagnostic: eligibility.diagnostic };
        if ((await o.herdr.preflight(d)) !== c.instance) throw new Error('herdr_instance_changed');
        if (!current()) return { receipt: r, diagnostic: 'panel_stale_context' };
        if (r && r.phase !== 'closed' && r.reason !== 'split_reply_lost') {
          await reconcile(s, r, o, d);
          await closeRecorded(s, r, o, d);
          if ((r as PanelReceipt).phase !== 'closed') throw new Error('panel_previous_generation_uncertain');
        }
        // Preflight/old-generation cleanup can yield. Recheck the originating
        // foreground/terminal rather than splitting beside a replaced main pane.
        const finalEligibility = await panelEligibility(c, o.herdr, d, o.native, o.processLaunch, o.processInfo);
        if (!finalEligibility.eligible) return { receipt: r, diagnostic: finalEligibility.diagnostic };
        if (!current()) return { receipt: r, diagnostic: 'panel_stale_context' };
        r = {
          ...c,
          schema: 1,
          kind: 'hud-panel-display',
          generation: randomUUID(),
          token: randomUUID(),
          phase: 'opening',
          panel: null,
        };
        receipt = r;
        // A permanent slot tombstone prevents total receipt loss authorizing a split.
        if (readJson(s.file(key, 'used')) === null) saveJson(s.file(key, 'used'), true, true);
        // Both the recovery intent and receipt precede the FIRST external mutation.
        saveJson(s.file(key, 'intent'), r);
        s.write(r);
        const env = {
          HUD_HOME: getHudHome(o.env),
          HUD_SETTINGS_PATH: resolveHudEnv(o.env, 'HUD_SETTINGS_PATH') || join(getHudHome(o.env), 'hud-settings.json'),
          HUD_PANEL_TOKEN: r.token,
          HUD_PANEL_GENERATION: r.generation,
          HUD_PANEL_KEY: key,
          HUD_DISPLAY_HOME: getHudDisplayHome(o.env),
        };
        let pane: string;
        try {
          const split = await o.herdr.split(r, env, d);
          pane = typeof split === 'string' ? split : split.pane;
          if (typeof split !== 'string' && split.workspace) r.createdWorkspace = split.workspace;
        } catch {
          r.phase = 'uncertain';
          r.reason = 'split_reply_lost';
          s.write(r);
          return splitLost(r);
        }
        if (pane === r.origin.pane) throw new Error('panel_main_pane_refused');
        r.createdPane = pane;
        s.write(r); // retain the ID before ANY readiness observation
        if (!(await awaitReady(s, r, o, d)))
          return { receipt: r, diagnostic: r.phase === 'closed' ? 'closed' : 'panel_shell_unavailable' };
        // Once submitted, even a lost reply is reconciliation-only.
        try {
          await o.herdr.start(pane, panelArgv(r), d);
        } catch {
          /* lost reply: wait for that exact token, never start again */
        }
        while (d.remaining(Infinity) > 750) {
          if (!current()) s.fence(r);
          if (await reconcile(s, r, o, d)) {
            if (!current()) s.fence(r);
            if (s.fenced(r)) await closeRecorded(s, r, o, d);
            return { receipt: r, diagnostic: r.phase };
          }
          if ((r as PanelReceipt).phase === 'closed') return { receipt: r, diagnostic: 'closed' };
          if (s.fenced(r)) {
            await closeRecorded(s, r, o, d);
            return { receipt: r, diagnostic: r.phase };
          }
          await pause(d);
        }
        await closeRecorded(s, r, o, d, true);
        return { receipt: r, diagnostic: 'panel_registration_missing' };
      } catch (error) {
        // Only the lock holder may publish a failed transition. A timed-out waiter
        // must not overwrite an opener's newer receipt with its earlier snapshot.
        if (receipt && receipt.phase !== 'closed') {
          receipt.phase = 'uncertain';
          s.write(receipt);
        }
        throw error;
      }
    });
  } catch (error) {
    return {
      receipt,
      diagnostic: error instanceof Error && /^[a-z_]{1,120}$/.test(error.message) ? error.message : 'panel_unknown',
    };
  } finally {
    d.dispose();
  }
}
/** Called by A7 in the panel process, before rendering; independent of the controller lock. */
export function registerPanel(env: NodeJS.ProcessEnv, panel: PaneIdentity): PanelReceipt {
  const s = new PanelStore(env);
  const key = env.HUD_PANEL_KEY ?? '';
  const r = s.read(key);
  if (
    !r ||
    r.token !== env.HUD_PANEL_TOKEN ||
    r.generation !== env.HUD_PANEL_GENERATION ||
    s.fenced(r) ||
    !['opening', 'uncertain'].includes(r.phase) ||
    panel.pane === r.origin.pane ||
    panel.tab !== r.origin.tab ||
    (r.createdPane !== undefined && panel.pane !== r.createdPane) ||
    (r.panel !== null && (panel.terminal !== r.panel.terminal || panel.workspace !== r.panel.workspace)) ||
    panel.process.pid !== process.pid ||
    !validPane(panel) ||
    !registeredProcess(r, panel)
  )
    throw new Error('panel_registration_refused');
  decodeReceipt(r);
  saveJson(s.registration(r.token), { generation: r.generation, panel });
  return { ...r, panel };
}
