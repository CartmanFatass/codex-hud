/** Synthetic context for the real p10k port. Only the stock editor frame is a host fake. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { visualWidth, truncateAnsi } from '../../src/render/colors.js';
import { createP10kFooter } from '../../src/harness/pi/p10k-footer.js';
import type { FooterContext, FooterHost, FooterComponent, FooterEditor } from '../../src/harness/pi/footer-host.js';
import { createPiSegment } from '../../src/harness/pi/segment.js';
const { createFooterHost } = await import(pathToFileURL(join(process.cwd(), 'tests/fakes/pi.mjs')).href);
// Native pi-tui closes even plain truncated fragments with SGR resets. All fixture
// fragments are plain text; ANSI is added later by the real port's painters.
function plainFooterTruncate(text: string, width: number, ellipsis = '...'): string {
  if (width <= 0) return '';
  if (visualWidth(text) <= width) return text;
  const clipped = truncateAnsi(text, width, ellipsis);
  return ellipsis ? clipped.slice(0, -ellipsis.length) + '\x1b[0m' + ellipsis + '\x1b[0m' : clipped + '\x1b[0m';
}
export const parityHost: FooterHost = createFooterHost({
  visibleWidth: visualWidth,
  truncateToWidth: plainFooterTruncate,
});
export const FOOTER_NOW = 1_800_000_000_000;
export interface ParityRow {
  name: string;
  width: number;
  working?: boolean;
  env?: Record<string, string>;
  settings?: unknown;
  delegation?: 'complete' | 'partial' | 'unavailable';
  lines: string[];
}
export function parityFixture(row: Omit<ParityRow, 'lines'>, owner: unknown, host = parityHost) {
  const home = mkdtempSync(join(tmpdir(), 'hud-footer-'));
  const env = { HOME: home, HUD_HOME: home, HERDR_PANE_ID: 'synthetic-main', ...row.env };
  writeFileSync(join(home, 'config.json'), JSON.stringify({ piFooter: row.settings ?? owner }), { mode: 0o600 });
  const statuses = new Map([['other', 'other status']]);
  const bus = new Map<string, (data: unknown) => void>();
  let editor: FooterEditor | undefined, footer: FooterComponent | undefined;
  let reads = 0,
    branches = 0,
    gitCalls = 0;
  const entries = [
    {
      type: 'message' as const,
      message: {
        role: 'assistant',
        model: 'synthetic-model',
        usage: { input: 10000, output: 2000, cacheRead: 30000, cacheWrite: 1000, cost: { total: 0.42 } },
      },
    },
    { type: 'custom' as const, customType: 'tps', data: { tps: 123.4, timing: { ttftMs: 520, totalMs: 242000 } } },
  ];
  const ctx: FooterContext & { ui: FooterContext['ui'] & { setStatus(key: string, value: string | undefined): void } } =
    {
      mode: 'tui',
      hasUI: true,
      model: {
        id: 'synthetic-model',
        name: 'Synthetic Model (Provider)',
        provider: 'openai',
        reasoning: true,
        contextWindow: 200000,
      },
      sessionManager: {
        getSessionId: () => 'synthetic-session',
        getLeafId: () => 'leaf',
        getEntries: () => {
          reads++;
          return entries;
        },
        getBranch: () => {
          branches++;
          return entries;
        },
        getCwd: () => join(home, 'projects/example'),
        getSessionName: () => 'Synthetic session title',
      },
      getContextUsage: () => ({ contextWindow: 200000, percent: 42 }),
      ui: {
        theme: { fg: (token, text) => `\x1b[38;5;${token === 'borderMuted' ? 240 : 245}m${text}\x1b[39m` },
        notify() {},
        setStatus(key, value) {
          if (value === undefined) statuses.delete(key);
          else statuses.set(key, value);
        },
        setEditorComponent(factory) {
          editor = factory?.({ requestRender() {} }, {}, {}) as FooterEditor | undefined;
        },
        setFooter(factory) {
          footer?.dispose?.();
          footer = factory?.({ requestRender() {} }, ctx.ui.theme, { getExtensionStatuses: () => statuses });
        },
        setWidget() {
          throw Error('unexpected_widget');
        },
      },
    };
  const controller = createP10kFooter(
    {
      getThinkingLevel: () => 'high',
      getAllTools: () => [],
      getCommands: () => [],
      events: {
        on(name, cb) {
          bus.set(name, cb);
          return () => {
            bus.delete(name);
          };
        },
      },
    },
    host,
    env,
    {
      gitStatus(_cwd, done) {
        gitCalls++;
        done(null, '## synthetic-main\nM  staged\n M unstaged\n?? new\n');
      },
    }
  );
  const segment = createPiSegment({ env, now: () => FOOTER_NOW, schedule: () => () => {} });
  const root = 'pi-synthetic/synthetic-session';
  function publish(coverage: 'complete' | 'partial' | 'unavailable') {
    const jobs = join(home, 'jobs');
    rmSync(jobs, { recursive: true, force: true });
    if (coverage !== 'unavailable')
      for (let i = 1; i <= 5; i++) {
        const id = `j${String(i).padStart(16, '0')}`,
          dir = join(jobs, id);
        mkdirSync(join(dir, 'qa'), { recursive: true });
        writeFileSync(
          join(dir, 'job.json'),
          JSON.stringify({
            job: id,
            role: 'imp',
            herdr_pane: env.HERDR_PANE_ID,
            created_at: new Date(FOOTER_NOW).toISOString(),
          })
        );
        if (i <= 2) writeFileSync(join(dir, 'qa/q1.md'), '# Question\n\nContinue?');
      }
    segment.refresh();
  }
  if (row.delegation) publish(row.delegation);
  controller.start(ctx);
  if (row.delegation) segment.start(ctx, root, () => true);
  if (row.working) {
    controller.turnStart(FOOTER_NOW - 5000);
    editor?.setWorkingStatusIndicator({ renderInBorder: () => '⠋ Working…' });
  }
  return {
    controller,
    ctx,
    statuses,
    bus,
    publish,
    counts: () => ({ reads, branches, gitCalls }),
    render(width = row.width) {
      footer?.render(width);
      return editor?.render(width) ?? [];
    },
    dispose() {
      segment.stop();
      controller.dispose();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
