/** Fixed busy facts through each client's real renderer; only pi's host shell is fake. */
import { parityFixture, FOOTER_NOW } from './pi-footer.js';
import { makeHudData, makeContextUsage } from './hud-data.js';
import { OWNER_CONFIG } from './claude-hud-parity/fixture.js';
import { paritySettings } from '../../dist/statusline-parity/settings.js';
import { renderParity } from '../../dist/statusline-parity/render.js';
import { fitStatusBar } from '../../dist/render/header.js';
import { DEFAULT_LAYOUT } from '../../dist/types.js';
import { setDisplayConfig, BAR_FIELDS, type BarStyle } from '../../dist/render/hud-config.js';

export const THEME_NOW = FOOTER_NOW;

const WORK = { running: 3, queued: 1 };
export function barThemeScene() {
  const footer = parityFixture({ name: 'bar-themes', width: 120, env: { NO_COLOR: '' } });
  footer.ctx.model!.id = 'deepseek-v4-1-flash-1017';
  footer.ctx.model!.provider = 'deepseek';
  footer.ctx.getContextUsage = () => ({ contextWindow: 200000, percent: 72 });
  footer.ctx.sessionManager.getSessionName = () => 'example';
  footer.controller.update();
  footer.controller.setWork(WORK);
  const data = makeHudData({
    config: { ...makeHudData().config, model: 'gpt-5.6-astra', model_reasoning_effort: 'xhigh' },
    session: undefined,
    project: { ...makeHudData().project, projectName: 'example', mcpCount: 2, skillsCount: 5 },
    git: { ...makeHudData().git, repo: 'example', branch: 'main', isDirty: true, ahead: 2, behind: 0 },
    contextUsage: makeContextUsage(88, 400000),
    rateLimits: { primary: { used_percent: 78, window_minutes: 300, resets_at: (THEME_NOW + 79 * 60000) / 1000 } },
    notices: [
      {
        kind: 'agent-started',
        subject: 'explorer',
        task: 'Synthetic search',
        at: new Date(THEME_NOW - 10000),
      },
      { kind: 'agent-done', subject: 'worker', ranMs: 95_000, at: new Date(THEME_NOW - 20000) },
    ],
    work: WORK,
  });
  return {
    footer,
    dispose: () => footer.dispose(),
    render(style: BarStyle, width = 120) {
      setDisplayConfig({ barStyle: style, theme: 'terminal', icons: 'unicode', barFields: [...BAR_FIELDS] });
      const claude = renderParity(
        {
          model: { id: 'claude-opus-5-5' },
          effort: 'high',
          cwd: '/synthetic/example',
          context_window: { used_percentage: 86, context_window_size: 400000 },
          rate_limits: { five_hour: { used_percentage: 92, resets_at: (THEME_NOW + 41 * 60000) / 1000 } },
        },
        width,
        paritySettings(OWNER_CONFIG),
        {
          transcript: {
            agents: [
              {
                id: 'a',
                type: 'frontend-implementer',
                model: 'claude-sonnet-5-5',
                start: THEME_NOW - 10000,
                startPos: 1,
                description: 'Synthetic',
                background: true,
              },
            ],
            skills: ['hud-delegate'],
            skillLoads: [{ name: 'hud-delegate', at: THEME_NOW - 20000 }],
            todos: [],
            ultracode: false,
            bytesRead: 0,
            pendingHistory: false,
          },
          counts: { mcpCount: 4 },
          git: { branch: 'main', dirty: true, ahead: 0, behind: 0 },
        },
        THEME_NOW,
        {},
        WORK
      );
      return {
        claude: claude.split('\n'),
        pi: footer.render(width),
        codex: [fitStatusBar(data, DEFAULT_LAYOUT, width, THEME_NOW).line],
        ribbon: [footer.top(width)],
      };
    },
  };
}
