import { isAbsolute } from 'node:path';
import { readExhausted, roleRegistry } from '../roles/roster.js';
import { loadSettings } from '../settings.js';

export interface EvenQuotaNotice {
  role: 'imp' | 'sonic';
  preset: string;
  until: number;
}

/** Read quota exclusions from the effective roster for this bar's project, in pool order. */
export function readEvenQuotaNotices(home: string, cwd: unknown, now: number, env = process.env): EvenQuotaNotice[] | undefined {
  const exhausted = readExhausted(home, now);
  if (!exhausted.size) return;
  try {
    const settings = loadSettings({ ...env, HUD_HOME: home });
    const pools = [
      ['imp', settings.impPlacement, settings.impEvenPool],
      ['sonic', settings.sonicPlacement, settings.sonicEvenPool],
    ] as const;
    if (!pools.some(([, placement, pool]) => placement === 'even' && pool.length)) return;
    const found = roleRegistry(home, typeof cwd === 'string' && cwd.length <= 4096 && isAbsolute(cwd) ? cwd : process.cwd(), env);
    const roles = found.roles();
    const routing = found.routing(now, exhausted);
    const notices: EvenQuotaNotice[] = [];
    for (const [role, placement, pool] of pools) {
      const chain = roles.get(role);
      if (placement !== 'even' || !chain) continue;
      const known = new Set(chain.presets?.map(p => p.name));
      for (const preset of new Set(pool)) {
        if (!known.has(preset)) continue;
        const assignment = found.assignment(chain, now, undefined, routing, { preset });
        if (assignment.available) continue;
        const until = assignment.places.reduce((earliest, place) =>
          place.state === 'exhausted' && !place.missing ? Math.min(earliest, Date.parse(place.until!)) : earliest, Infinity);
        if (Number.isFinite(until)) notices.push({ role, preset, until });
      }
    }
    return notices.length ? notices : undefined;
  } catch {
    // Bad/missing roster evidence must not prevent the bar from drawing.
    return;
  }
}
