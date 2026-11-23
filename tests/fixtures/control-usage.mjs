/** Control → Usage → Dispatch today with synthetic roles, at the narrow widths (panel-polish/02): one row per role, place names cut at the end. */
import { radarFacts, radarRows } from '../../dist/render/control-view.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { stripAnsi } from '../../dist/render/colors.js';
const place = (ok, failed, o = {}) => ({ launches: ok + failed, launchFailed: 0, ok, failed, quietEscalated: 0, quota: 0, ...o });
export const ROLE_STATS = {
  'frontend-imp': { total: 6, ok: 5, failed: 0, quietEscalated: 0, avgMinutes: 12 },
  general: {
    total: 23, ok: 21, failed: 1, quietEscalated: 2, avgMinutes: 10,
    places: { 'cli/agy (gemini-4-neon-high)': place(19, 0), 'pi (openai/gpt-6.2-sol-fast)': place(2, 0), 'cli/agy (gemini-4-neon-xhigh)': place(0, 1) },
  },
  imp: {
    total: 31, ok: 30, failed: 0, quietEscalated: 0, avgMinutes: 9,
    places: { 'pi (openai/gpt-6.2-sol-fast)': place(20, 0), 'pi (openai/gpt-6.2-astra)': place(8, 0), 'cli/agy (gemini-4-hydrogen-high)': place(2, 0) },
  },
  oracle: { total: 5, ok: 3, failed: 1, quietEscalated: 0, avgMinutes: 21 },
};
export const dispatchFrames = () => Object.fromEntries(['en', 'zh'].map((lang) => {
  const display = setDisplayConfig({ theme: 'none', icons: 'unicode' }), previous = setLanguage(lang);
  try { return [`${lang}-42`, radarRows(radarFacts({ roleStats: ROLE_STATS }), 42, true).map((r) => stripAnsi(r.text))]; }
  finally { setDisplayConfig(display); setLanguage(previous); }
}));
