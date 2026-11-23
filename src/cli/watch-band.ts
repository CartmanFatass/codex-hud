/** What needs the owner now, for the Claude mod's band above the prompt: the Project Inbox's own facts and nothing else. */
import * as fs from 'node:fs';
import { ProjectCollector } from '../collectors/project-board.js';
import type { WorkboardSnapshot } from '../collectors/workboard-types.js';
import { resolveLanguage, type Language } from '../render/i18n.js';
import { monitorText } from '../render/monitor-text.js';
import { loadSettings } from '../settings.js';

/** `waiting`: STATE's `Waiting for the owner` items (settled `(waits on …)` ones dropped) with the first one's text; `accept`: slices to try, as Accept all counts them. */
export interface Band { type: 'band'; lang: Language; waiting: number; first: string; accept: number; fresh: boolean }

const NO_WORKERS: WorkboardSnapshot = { revision: '', lanes: [], workers: [], decisions: [], coverage: { incomplete: false, workspace: null, diagnostics: [] } };

/** Reads the band for `cwd`; each read answers a record only when the band changed, `fresh` when something new needs the owner (never on the first read), and nothing when the read failed. */
export function bandReader(cwd: string, home: string, env: NodeJS.ProcessEnv) {
  let root = cwd;
  try { root = fs.realpathSync(cwd); } catch { /* The collector reads what it can. */ }
  const collector = new ProjectCollector(root, home, env);
  let seen: Set<string> | undefined, accept = 0, shown = '';
  return async (now: number): Promise<Band | undefined> => {
    let data;
    try { data = await collector.collect('home', NO_WORKERS, now); } catch { return undefined; }
    if (!data) return undefined;
    let lang: Language = 'en';
    try { lang = resolveLanguage(loadSettings(env).language, env); } catch { /* Unreadable settings: defaults. */ }
    const waiting = data.waiting.map((item) => monitorText(item.value)), pending = data.ledger.filter((row) => row.state === 'try').length;
    const key = [lang, pending, ...waiting].join('\0');
    if (key === shown) return undefined;
    const fresh = !!seen && (waiting.some((item) => !seen!.has(item)) || pending > accept);
    shown = key;
    seen = new Set(waiting);
    accept = pending;
    return { type: 'band', lang, waiting: waiting.length, first: waiting[0]?.slice(0, 240) ?? '', accept: pending, fresh };
  };
}
