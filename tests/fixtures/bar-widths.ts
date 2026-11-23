/**
 * The default look's bars at the widths a main pane has beside the open panel (BAR-NARROW): 184 columns less the
 * 40-column panel is 144, then smaller windows 120, 100 and 80. Plain text, synthetic facts only.
 */
import {
  renderBar,
  agentEvent,
  type BarFacts,
  type BarQuotaWindow,
} from '../../dist/render/layout/bar-fields.js';
import { renderPiBar } from '../../dist/harness/pi/p10k-footer.js';
import { setDisplayConfig, BAR_FIELDS } from '../../dist/render/hud-config.js';
import { stripAnsi } from '../../dist/render/colors.js';
import { barThemeScene, THEME_NOW } from './bar-themes.js';

export const BAR_WIDTHS = [144, 120, 100, 80] as const;
export const PI_QUOTA_WIDTHS = [144, 120, 80, 36] as const;

const fiveHour = { label: '5h', percent: 11, reset: '3h12m' };
const sevenDay = { label: '7d', percent: 43, reset: '2d4h', shown: '≈43%' };
const piFacts: BarFacts = {
  model: { name: '6.2-sol', id: 'gpt-6.2-sol', effort: 'high' },
  context: { percent: 72, shown: '72%', window: 200_000 },
  project: { name: 'example', branch: 'synthetic-main', marks: ' +1 *1 ?1', dirty: true },
  loaded: {
    counts: [
      ['MCP', 2],
      ['skills', 3],
    ],
    words: [[['lens', 'dim'], [' '], ['✓', 'ok']]],
  },
};
const piWindows = (...windows: BarQuotaWindow[]): BarFacts => ({ ...piFacts, quota: { windows, trailing: true } });
export const PI_QUOTA_SCENES = {
  'pi-quota': piWindows(fiveHour, sevenDay),
  'pi-quota-high': piWindows({ label: '5h', percent: 92, reset: '41m' }, sevenDay),
  'pi-quota-stale': piWindows(
    { ...fiveHour, shown: '≈11%?', quiet: true, reset: '' },
    { ...sevenDay, shown: '≈43%?', quiet: true, reset: '' }
  ),
  'pi-quota-pending': piWindows({ label: '5h', shown: '↻', quiet: true }, sevenDay),
  'pi-api': piWindows({ label: 'API', percent: 75, shown: '≈$12.34', reset: '12d' }),
  'pi-api-high': piWindows({ label: 'API', percent: 96, shown: '≈$2.05', reset: '3d' }),
};

function piQuotaFrames(width: number) {
  return Object.fromEntries(
    Object.entries(PI_QUOTA_SCENES).map(([name, facts]) => [
      name,
      [stripAnsi(renderPiBar(facts, width, THEME_NOW, 'line'))],
    ])
  );
}

const vitals: BarFacts = {
  model: { name: 'opus-5.5', id: 'claude-opus-5-5', effort: 'high' },
  context: { percent: 41, shown: '41%', window: 1_000_000 },
  project: { name: 'example', branch: 'wt/BAR-NARROW', marks: '*↑2', dirty: true },
  quota: {
    windows: [
      { label: '5h', percent: 62, reset: '1h19m' },
      { label: '7d', percent: 31, reset: '3d4h' },
    ],
  },
  tps: 42.7,
  loaded: {
    counts: [
      ['MCP', 4],
      ['skills', 31],
    ],
  },
};
const BUSY_WORK = { running: 8, queued: 2 };
const sub = agentEvent('started', { id: 'a', name: 'Explore', title: 'Audit bar fitting ladder' }, THEME_NOW - 10_000);
/** Idle; one worker running; the sample's eight workers; those and a subagent that just started. */
const WIDTH_SCENES: Record<string, BarFacts> = {
  quiet: vitals,
  one: { ...vitals, work: { running: 1, queued: 0 } },
  busy: { ...vitals, work: BUSY_WORK },
  mixed: { ...vitals, work: BUSY_WORK, events: [sub] },
};

/** Per width: the three scenes through `renderBar`, and the real Claude, pi and Codex paths of the themes' scene. */
export function widthFrames(): Record<string, Record<string, string[]>> {
  const now = Date.now;
  Date.now = () => THEME_NOW;
  const previous = setDisplayConfig({
    theme: 'terminal',
    barStyle: 'line',
    icons: 'unicode',
    barFields: [...BAR_FIELDS],
  });
  const scene = barThemeScene();
  try {
    const frames: Record<string, Record<string, string[]>> = {};
    for (const width of BAR_WIDTHS) {
      setDisplayConfig({ theme: 'terminal', barStyle: 'line', icons: 'unicode', barFields: [...BAR_FIELDS] });
      const own = Object.fromEntries(
        Object.entries(WIDTH_SCENES).map(([name, facts]) => [
          name,
          [stripAnsi(renderBar(facts, width, THEME_NOW).line)],
        ])
      );
      const { claude, pi, codex } = scene.render('line', width);
      frames[String(width)] = {
        ...own,
        claude: claude.map(stripAnsi),
        pi: pi.map(stripAnsi),
        codex: codex.map(stripAnsi),
        ...(width !== 100 ? piQuotaFrames(width) : {}),
      };
    }
    frames['36'] = piQuotaFrames(36);
    return frames;
  } finally {
    scene.dispose();
    setDisplayConfig(previous);
    Date.now = now;
  }
}
