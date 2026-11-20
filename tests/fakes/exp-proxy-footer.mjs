import { createP10kFooter } from '../../dist/harness/pi/p10k-footer.js';
import { stripAnsi, truncateAnsi, visualWidth } from '../../dist/render/colors.js';
import { createFooterHost } from './pi.mjs';

export function proxyFooter(env, subscription, repaint = () => {}) {
  let component;
  let oauth = true;
  const ctx = {
    mode: 'tui',
    hasUI: true,
    model: { id: 'synthetic-model', provider: 'openai' },
    modelRegistry: { isUsingOAuth: () => oauth },
    getContextUsage: () => ({ percent: 42, contextWindow: 200000 }),
    sessionManager: {
      getSessionId: () => 'synthetic-session',
      getLeafId: () => null,
      getEntries: () => [],
      getBranch: () => [],
      getCwd: () => '/synthetic/example',
    },
    ui: {
      setEditorComponent() {},
      setFooter(factory) {
        component = factory?.({ requestRender: repaint }, {}, { getExtensionStatuses: () => new Map() });
      },
    },
  };
  const host = createFooterHost({ visibleWidth: visualWidth, truncateToWidth: truncateAnsi });
  const controller = createP10kFooter(
    {},
    host,
    { ...env, NO_COLOR: '1' },
    {
      gitStatus: (_, done) => done(null, ''),
      subscription,
    }
  );
  controller.start(ctx);
  return {
    ctx,
    controller,
    draw: (width = 40) => stripAnsi(component?.render(width).join('\n') ?? ''),
    oauth: (value) => {
      oauth = value;
    },
    stop: () => controller.dispose(),
  };
}
