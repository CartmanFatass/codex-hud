/**
 * Quota, trends and notifications.
 *
 * The recurring rule: the HUD reports what was observed and when. A reset
 * time that has passed is not proof the quota came back, and a quiet log is
 * not an event worth waking someone for.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { formatCountdown, readQuotaWindows, resolveResetTime } from '../../src/render/quota.js';
import { sparkline } from '../../src/render/sparkline.js';
import { SampleHistory } from '../../src/collectors/history.js';
import { Notifier, desktopNotificationSequence, resolveNotifierOptions } from '../../src/notify.js';
import { renderPanelPlain } from '../../src/render/subagent-tree-view.js';
import { initialPanelState } from '../../src/render/panel-state.js';
import { collectAttention } from '../../src/render/attention.js';
import { renderHud } from '../../src/render/header.js';
import { buildBarModules } from '../../src/render/layout/bar-modules.js';
import { stripAnsi } from '../../src/render/colors.js';
import { DEFAULT_LAYOUT } from '../../src/types.js';
import type { NotifyEvent } from '../../src/notify.js';
import {
  FIXED_NOW,
  at,
  makeHudData,
  makeContextUsage,
  makeNestedTree,
  node,
  treeOf,
} from '../fixtures/hud-data.js';

const NOW = FIXED_NOW.getTime();

test('reset times are read in every shape they arrive in', () => {
  const epochSeconds = Math.floor(at(3600).getTime() / 1000);
  assert.equal(resolveResetTime({ resets_at: epochSeconds }, NOW)?.toISOString(), at(3600).toISOString());
  assert.equal(resolveResetTime({ resets_at: at(3600).getTime() }, NOW)?.toISOString(), at(3600).toISOString());
  assert.equal(resolveResetTime({ resets_at: at(3600).toISOString() }, NOW)?.toISOString(), at(3600).toISOString());
  assert.equal(resolveResetTime({ resets_in_seconds: 3600 }, NOW)?.toISOString(), at(3600).toISOString());
  assert.equal(resolveResetTime({}, NOW), null);
});

test('a countdown reads in hours, minutes, then seconds', () => {
  assert.equal(formatCountdown(at(5000), NOW), '1h23m');
  assert.equal(formatCountdown(at(3600), NOW), '1h');
  assert.equal(formatCountdown(at(300), NOW), '5m');
  assert.equal(formatCountdown(at(9), NOW), '9s');
});

test('an elapsed reset is reported as due, not as restored', () => {
  const windows = readQuotaWindows(
    { primary: { used_percent: 96, window_minutes: 300, resets_at: Math.floor(at(-60).getTime() / 1000) } },
    NOW
  );
  assert.equal(windows[0].resetDue, true);
  assert.equal(windows[0].percent, 96, 'the last reported figure stands until a new snapshot arrives');
});

test('the quota field carries the countdown and never invents a reset', () => {
  const quotaOf = (data: ReturnType<typeof makeHudData>) =>
    stripAnsi(
      buildBarModules(data, { nowMs: NOW }).find((module) => module.id === 'quota')?.variants.full ?? ''
    );

  assert.match(quotaOf(makeHudData()), /resets in 1h23m/);

  const overdue = makeHudData({
    rateLimits: { primary: { used_percent: 88, window_minutes: 300, resets_at: Math.floor(at(-60).getTime() / 1000) } },
  });
  const text = quotaOf(overdue);
  assert.match(text, /reset due/);
  assert.match(text, /88%/, 'the last reported figure stands');
  assert.doesNotMatch(text, /100%|0%/, 'a passed reset time must not be turned into a fresh window');
});

test('the bar keeps the quota label when it has to shorten it', () => {
  const text = stripAnsi(
    renderHud(makeHudData(), { width: 200, showDetails: false, layout: { ...DEFAULT_LAYOUT, mode: 'compact' } })[0]
  );
  assert.match(text, /Q5h 61%/);
});

test('the sparkline keeps a fixed scale so flat reads as flat', () => {
  assert.equal(sparkline([50, 50, 50], 3), '▅▅▅');
  assert.equal(sparkline([0, 100], 2), '▁█');
  assert.equal(sparkline([10, 20, 30, 40], 2), '▃▄', 'only the most recent samples are shown');
  assert.equal(sparkline([], 8), '');
});

test('history collapses samples that arrive faster than the interval', () => {
  const history = new SampleHistory(10, 1000);
  history.push(10, NOW);
  history.push(11, NOW + 100);
  history.push(20, NOW + 1200);
  assert.deepEqual(history.values(), [11, 20]);
  assert.equal(history.spanMs(), 1200);
});

test('the panel labels the window its trend covers', () => {
  const page = renderPanelPlain({
    tree: makeNestedTree(),
    state: { ...initialPanelState(), view: 'session' },
    maxWidth: 40,
    nowMs: NOW,
    contextUsage: makeContextUsage(42),
    rateLimits: { primary: { used_percent: 61, window_minutes: 300, resets_at: Math.floor(at(4980).getTime() / 1000) } },
    contextHistory: [30, 35, 40, 42],
    contextHistoryMs: 180_000,
  });
  assert.match(page, /last 3m/);
  assert.match(page, /resets in 1h23m/);
  assert.match(page, /42%/);
});

test('notifications stay silent unless switched on', () => {
  const sent: NotifyEvent[] = [];
  const notifier = new Notifier({ enabled: false, cooldownMs: 1000, deliver: (event) => sent.push(event) });
  notifier.update(makeHudData(), NOW);
  assert.equal(sent.length, 0);
});

test('the same failure is announced once', () => {
  const sent: NotifyEvent[] = [];
  const notifier = new Notifier({ enabled: true, cooldownMs: 60_000, deliver: (event) => sent.push(event) });
  const data = makeHudData({ toolActivity: undefined });

  notifier.update(data, NOW);
  notifier.update(data, NOW + 1000);
  notifier.update(data, NOW + 2000);

  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /agent failed/);
});

test('several agents finishing at once become one message', () => {
  const sent: NotifyEvent[] = [];
  const notifier = new Notifier({ enabled: true, cooldownMs: 60_000, deliver: (event) => sent.push(event) });
  const quiet = { toolActivity: undefined, rateLimits: undefined, contextUsage: undefined };

  const running = makeHudData({
    ...quiet,
    subagentTree: treeOf([
      node('a1', 'one', 'running'),
      node('a2', 'two', 'running'),
      node('a3', 'three', 'running'),
    ]),
  });
  const finished = makeHudData({
    ...quiet,
    subagentTree: treeOf([
      node('a1', 'one', 'completed'),
      node('a2', 'two', 'completed'),
      node('a3', 'three', 'completed'),
    ]),
  });

  notifier.update(running, NOW);
  notifier.update(finished, NOW + 1000);

  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /3 agents finished/);
});

test('a desktop notification is two sequences a terminal can ignore', () => {
  assert.equal(
    desktopNotificationSequence('build finished', { tmux: false }),
    '\x1b]9;build finished\x07\x1b]777;notify;codex-hud;build finished\x07'
  );
});

test('under tmux the sequences are wrapped in passthrough with every ESC doubled', () => {
  const wrapped = desktopNotificationSequence('build finished', { tmux: true });
  assert.equal(
    wrapped,
    '\x1bPtmux;\x1b\x1b]9;build finished\x07\x1b\x1b]777;notify;codex-hud;build finished\x07\x1b\\'
  );
  // Unwrapping is exactly un-doubling, which is what tmux does to the payload.
  const payload = wrapped.slice('\x1bPtmux;'.length, -'\x1b\\'.length);
  assert.equal(
    payload.split('\x1b\x1b').join('\x1b'),
    desktopNotificationSequence('build finished', { tmux: false })
  );
});

test('notification text cannot close the sequence and run the rest as commands', () => {
  // The message comes from a rollout, so it is data. An ESC inside it would
  // otherwise end the OSC and leave the tail to be executed.
  const hostile = 'ok\x07\x1b]0;pwned\x07\x1b[2J\r\nrm -rf /\x00';
  const plain = desktopNotificationSequence(hostile, { tmux: false });
  const safe = 'ok  ]0;pwned  [2J  rm -rf /';
  assert.equal(plain, `\x1b]9;${safe}\x07\x1b]777;notify;codex-hud;${safe}\x07`);
  assert.equal(plain.split('\x1b').length - 1, 2, 'only the two sequences we wrote carry an ESC');
  assert.equal(plain.split('\x07').length - 1, 2, 'and only the two terminators we wrote');

  const wrapped = desktopNotificationSequence(hostile, { tmux: true });
  assert.ok(!wrapped.includes('\x1b\\\x1b'), 'the payload cannot terminate the passthrough early');
  assert.ok(wrapped.endsWith('\x1b\\'));
});

test('desktop notifications are a second opt-in, not a consequence of the first', () => {
  assert.equal(resolveNotifierOptions({ CODEX_HUD_NOTIFY: '1' }).desktop, false);
  assert.equal(resolveNotifierOptions({ CODEX_HUD_NOTIFY: '1', CODEX_HUD_NOTIFY_DESKTOP: '1' }).enabled, true);
  assert.equal(resolveNotifierOptions({ CODEX_HUD_NOTIFY: '1', CODEX_HUD_NOTIFY_DESKTOP: '1' }).desktop, true);
  assert.equal(resolveNotifierOptions({ CODEX_HUD_NOTIFY_DESKTOP: 'true' }).enabled, false, 'still off overall');
});

test('silence is never announced as a failure', () => {
  const stale = makeHudData({
    toolActivity: undefined,
    rateLimits: undefined,
    contextUsage: undefined,
    subagentTree: treeOf([node('a1', 'quiet', 'unknown', { lastEventAt: at(-7200) })]),
  });
  assert.deepEqual(collectAttention(stale, NOW), []);

  const sent: NotifyEvent[] = [];
  const notifier = new Notifier({ enabled: true, cooldownMs: 1000, deliver: (event) => sent.push(event) });
  notifier.update(stale, NOW);
  assert.equal(sent.length, 0);
});
