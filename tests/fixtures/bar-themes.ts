/** Fixed busy facts through each client's real renderer; only pi's host shell is fake. */
import { parityFixture, FOOTER_NOW } from './pi-footer.js';
import { makeHudData, makeContextUsage } from './hud-data.js';
import { OWNER_CONFIG } from './claude-hud-parity/fixture.js';
import { paritySettings } from '../../src/statusline-parity/settings.js';
import { renderParity } from '../../src/statusline-parity/render.js';
import { fitStatusBar } from '../../src/render/header.js';
import { DEFAULT_LAYOUT } from '../../src/types.js';
import { setDisplayConfig, BAR_FIELDS, type BarStyle } from '../../src/render/hud-config.js';
import { agentEvent } from '../../src/render/layout/bar-fields.js';

export const THEME_NOW = FOOTER_NOW;
export function barThemeScene() {
  const footer = parityFixture({ name: 'bar-themes', width: 120, env: { NO_COLOR: '' } });
  footer.ctx.model!.id = 'deepseek-v4-1-flash-1017';
  footer.ctx.model!.provider = 'deepseek';
  footer.ctx.getContextUsage = () => ({ contextWindow: 200000, percent: 72 });
  footer.ctx.sessionManager.getSessionName = () => 'example';
  footer.controller.update();
  footer.controller.setWork({
    needs: [],
    events: [
      agentEvent('started', { name: 'imp', model: 'gpt-6.1-sol', effort: 'high' }, THEME_NOW - 10000),
      agentEvent('done', { name: 'reviewer', model: 'gpt-6.1-sol', effort: 'xhigh' }, THEME_NOW - 20000),
    ],
  });
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
        model: 'gpt-5.6-astra',
        effort: 'medium',
        at: new Date(THEME_NOW - 10000),
      },
      { kind: 'agent-done', subject: 'worker', model: 'gpt-5.6-luna', at: new Date(THEME_NOW - 20000) },
    ],
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
          definitions: { 'frontend-implementer': { effort: 'xhigh' } },
        },
        THEME_NOW
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
