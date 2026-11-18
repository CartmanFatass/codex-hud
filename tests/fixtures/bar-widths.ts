/**
 * The default look's bars at the widths a main pane has beside the open panel (BAR-NARROW): 184 columns less the
 * 40-column panel is 144, then smaller windows 120, 100 and 80. Plain text, synthetic facts only.
 */
import { renderBar, agentEvent, type BarFacts } from '../../src/render/layout/bar-fields.js';
import { setDisplayConfig, BAR_FIELDS } from '../../src/render/hud-config.js';
import { stripAnsi } from '../../src/render/colors.js';
import { barThemeScene, THEME_NOW } from './bar-themes.js';

export const BAR_WIDTHS = [144, 120, 100, 80] as const;

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
const job = agentEvent(
  'done',
  {
    id: 'j',
    name: 'frontend-implementer',
    title: 'BAR-NARROW: the bottom bar reads well beside the panel',
    job: true,
    unread: true,
  },
  THEME_NOW - 20_000,
  754_000
);
const sub = agentEvent('started', { id: 'a', name: 'Explore', title: 'Audit bar fitting ladder' }, THEME_NOW - 10_000);
/** Idle; one settled job with an unread report; that job and a subagent that just started. */
export const WIDTH_SCENES: Record<string, BarFacts> = {
  quiet: vitals,
  one: { ...vitals, events: [job] },
  busy: { ...vitals, events: [sub, job] },
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
      };
    }
    return frames;
  } finally {
    scene.dispose();
    setDisplayConfig(previous);
    Date.now = now;
  }
}
