import test from 'node:test';
import assert from 'node:assert/strict';
import { initialMonitorState, handleMonitorInput, renderMonitor, monitorSettings, type MonitorFrame, type MonitorPane } from '../../src/render/monitor.js';
import { cardSummaryTargets } from '../../src/render/cards.js';
import { defaultSettings } from '../../src/settings.js';
import { setLanguage } from '../../src/render/i18n.js';
import { setDisplayConfig } from '../../src/render/hud-config.js';
import { stripAnsi, visualLength } from '../../src/render/colors.js';
import type { SubagentTree } from '../../src/types.js';
import type { AgentLogEntry } from '../../src/collectors/agent-log.js';

const NOW = Date.parse('2026-10-14T10:00:00Z');
const tree: SubagentTree = {
  rootId: 'synthetic-root', totalCount: 4, updatedAt: new Date(NOW),
  nodes: [{ id: 'lead', name: 'Lead', status: 'running', depth: 1,
    children: ['Helper A', 'Helper B', 'Helper C'].map((name, i) => ({
      id: `child-${i}`, name, depth: 2, status: 'running' as const,
      role: i === 2 ? 'team-implementer' : 'team-scout', children: [],
    })) }],
};
const log = new Map<string, AgentLogEntry[]>(tree.nodes[0].children.map(child => [child.id, [
  { kind: 'note', lang: 'en', at: NOW, text: 'Checks synthetic evidence.' },
]]));

function navFrame(state: ReturnType<typeof initialMonitorState>, pane: MonitorPane): MonitorFrame {
  return { lines: ['navigation'], state, panes: [], controls: [{ kind: 'tab', pane, x: 2, y: 0, width: 5 }] };
}

test('leaving Settings via a tab opens/selects the pane, never toggles an already open pane shut', () => {
  for (const tabbed of [false, true]) {
    for (const pane of ['agents', 'timeline', 'changes', 'details'] as const) {
      for (const mode of ['closed', 'open'] as const) {
        const state = { ...initialMonitorState(), tabbed, zoom: true };
        state.modes[pane] = mode;
        const result = handleMonitorInput(state, { type: 'mouse', button: 'left', x: 3, y: 0 },
          { tree, frame: navFrame(state, pane), navigationOverlay: true });
        assert.equal(result.state.focus, pane);
        assert.equal(result.state.zoom, false);
        assert.equal(result.state.modes[pane], tabbed ? mode : 'open');
        assert.equal(result.close, false);
        const keyed = handleMonitorInput(state, { type: 'key', key: pane }, { tree, navigationOverlay: true });
        assert.equal(keyed.state.focus, pane);
        assert.equal(keyed.state.modes[pane], tabbed ? mode : 'open');
      }
    }
  }
});

test('normal stacked tab clicks still toggle pane visibility outside Settings', () => {
  const state = initialMonitorState();
  const result = handleMonitorInput(state, { type: 'mouse', button: 'left', x: 3, y: 0 }, { tree, frame: navFrame(state, 'agents') });
  assert.equal(result.state.modes.agents, 'closed');
});

test('the footer role-count switch hides counts only, keeping children, their sentences and progress eligibility', () => {
  const language = setLanguage('en');
  const config = setDisplayConfig({ icons: 'unicode', look: 'tab' });
  try {
    for (const width of [32, 40, 48, 56, 80]) {
      const draw = (counts: boolean) => {
        const settings = { ...defaultSettings(), cardRoleCounts: counts, cardClock: false };
        const state = { ...initialMonitorState(), ...monitorSettings(settings) };
        return renderMonitor({ tree, state, agentLog: log, width, height: 40, nowMs: NOW });
      };
      const shown = draw(true), hidden = draw(false);
      const visible = shown.lines.map(stripAnsi).join('\n');
      const removed = hidden.lines.map(stripAnsi).join('\n');
      assert.match(visible, /2 scout/, `counts shown at ${width}`);
      assert.doesNotMatch(removed, /2 scout|1 implementer/, `counts hidden at ${width}`);
      for (const name of ['Helper A', 'Helper B', 'Helper C']) assert.ok(removed.includes(name), `${name} stays at ${width}`);
      assert.match(removed, /Checks synthetic/);
      assert.match(removed, /evidence\./);
      assert.deepEqual(cardSummaryTargets({ tree, agentLog: log }, shown.state, NOW),
        cardSummaryTargets({ tree, agentLog: log }, hidden.state, NOW));
      assert.ok(hidden.lines.every(line => visualLength(line) === width));
    }
  } finally { setLanguage(language); setDisplayConfig(config); }
});
