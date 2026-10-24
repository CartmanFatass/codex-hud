import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HudData } from '../types.js';

/** Read bounded, private per-attach reports on the collection path, never during rendering. */
export class BridgeHealthReader {
  private checkedAt = -Infinity;
  private cached: HudData['bridgeHealth'];
  private firstReadAt: number | undefined;
  constructor(private readonly home: string, private readonly env: NodeJS.ProcessEnv = process.env) {}

  read(now = Date.now()): HudData['bridgeHealth'] {
    if (now - this.checkedAt < 1000) return this.cached;
    this.checkedAt = now;
    this.firstReadAt ??= now;
    const session = this.env.CODEX_HUD_TMUX_SESSION;
    if (!session) return undefined;
    const dir = path.join(this.home, 'hud', 'herdr', session.replace(/[^A-Za-z0-9._-]/g, '_'));
    const reports: Array<{ updatedAtMs: number; transport: { status: string; lastSuccessAtMs?: number }; probe: { status: string }; notificationGap?: boolean; mode?: 'native' | 'report'; nativeState?: string; stateMatches?: boolean }> = [];
    try {
      for (const file of fs.readdirSync(dir).filter(name => /^\d+\.json$/.test(name))) {
        try {
          const full = path.join(dir, file);
          if (fs.statSync(full).size > 16 * 1024) continue;
          const record = JSON.parse(fs.readFileSync(full, 'utf8'));
          if (record.schemaVersion !== 1 || record.session !== session || record.lifecycle !== 'running' ||
            (this.env.CODEX_HUD_MAIN_PANE && record.mainPaneId !== this.env.CODEX_HUD_MAIN_PANE) ||
            !Number.isFinite(record.updatedAtMs) || record.updatedAtMs < 0 || record.updatedAtMs > now + 5000 || !record.transport || !record.probe) continue;
          reports.push(record);
        } catch { /* One corrupt/stopping attach does not hide the others. */ }
      }
    } catch { /* Not attached in Herdr, or no first report yet. */ }
    const live = reports.filter(record => now - record.updatedAtMs <= 20_000 && record.updatedAtMs <= now + 5000);
    // The HUD belongs to a reusable tmux session, not its creating outer Herdr pane.
    // Another attach may be the current viewer; aggregate live attachments, ignoring old stopped/stale writers.
    const latest = (live.length ? live : reports).sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0];
    if (!latest) return this.cached = this.env.HERDR_ENV === '1' && this.env.CODEX_HUD_HERDR_BRIDGE !== '0'
      ? { state: now - this.firstReadAt > 20_000 ? 'unavailable' : 'pending' } : undefined;
    this.cached = {
      ...(latest.mode === 'native' || latest.mode === 'report' ? { mode: latest.mode } : {}),
      ...(latest.mode === 'native' && ['idle', 'working', 'blocked', 'done', 'unknown'].includes(latest.nativeState ?? '')
        ? { nativeState: latest.nativeState as NonNullable<HudData['bridgeHealth']>['nativeState'] } : {}),
      stateMismatch: live.some(record => record.stateMatches === false || record.probe.status === 'mismatch'),
      state: !live.length ? 'unresponsive' : live.some(record => record.transport.status === 'disconnected') ? 'disconnected'
        : live.some(record => record.transport.status === 'pending') ? 'pending' : 'connected',
      probeFailed: live.some(record => record.probe.status !== 'ok' && record.probe.status !== 'mismatch'), notificationGap: live.some(record => record.notificationGap === true),
      ...(Number.isFinite(latest.transport.lastSuccessAtMs) && latest.transport.lastSuccessAtMs! >= 0 && latest.transport.lastSuccessAtMs! <= now + 5000
        ? { lastSuccessAtMs: latest.transport.lastSuccessAtMs } : {}),
    };
    return this.cached;
  }
}
