/**
 * Quota, trends and notifications.
 *
 * The recurring rule: the HUD reports what was observed and when. A reset
 * time that has passed is not proof the quota came back, and a quiet log is
 * not an event worth waking someone for.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { formatCountdown, formatCredits, quotaState, readCredits, readQuotaWindows, resolveResetTime } from '../../src/render/quota.js';
import { statusCard } from '../../src/render/status-block.js';
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

test('a countdown reads in days and hours, hours and minutes, then seconds', () => {
  assert.equal(formatCountdown(at(103 * 3600 + 60), NOW), '4d7h', 'a weekly window: not 103h1m');
  assert.equal(formatCountdown(at(2 * 86400 + 59), NOW), '2d');
  assert.equal(formatCountdown(at(86399), NOW), '23h59m');
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

test('the quota field is one reading, the tightest window, and never invents a reset', () => {
  const quotaOf = (data: ReturnType<typeof makeHudData>) =>
    stripAnsi(
      buildBarModules(data, { nowMs: NOW }).find((module) => module.id === 'quota')?.variants.full ?? ''
    );

  assert.equal(quotaOf(makeHudData()), '5h 61%', 'the 5h window at 61% is tighter than the 7d at 23%');
  assert.equal(quotaOf(makeHudData({ rateLimits: { primary: { used_percent: 12, window_minutes: 300 }, secondary: { used_percent: 81, window_minutes: 10080 } } })), '7d 81%');

  const overdue = makeHudData({
    rateLimits: { primary: { used_percent: 88, window_minutes: 300, resets_at: Math.floor(at(-60).getTime() / 1000) } },
  });
  const text = quotaOf(overdue);
  assert.equal(text, '5h 88%', 'the last reported figure stands');
  assert.doesNotMatch(text, /100%|0%/, 'a passed reset time must not be turned into a fresh window');
});

test('a full window with credits behind it reads the balance and is not a stop', () => {
  const full = (credits: { has_credits?: boolean; unlimited?: boolean; balance?: string } | null, reached: string | null = null) => makeHudData({
    rateLimits: { primary: { used_percent: 100, window_minutes: 10080, resets_at: Math.floor(at(3600).getTime() / 1000) }, credits, rate_limit_reached_type: reached },
  });
  const kinds = (data: ReturnType<typeof makeHudData>) => collectAttention(data, NOW).map((item) => item.kind);
  const quotaOf = (data: ReturnType<typeof makeHudData>) =>
    stripAnsi(buildBarModules(data, { nowMs: NOW }).find((module) => module.id === 'quota')?.variants.full ?? '');

  const paying = full({ has_credits: true, unlimited: false, balance: '31831.4484050000' });
  assert.deepEqual(readCredits(paying.rateLimits), { unlimited: false, balance: 31831.448405 });
  assert.ok(!kinds(paying).includes('quota-exhausted'), 'Codex goes on, on credits');
  const card = statusCard(paying, NOW)!;
  assert.equal(card.quota?.label, 'credits 31.8K', 'the full bar says 100%; the reading says what is left');
  assert.equal(card.quota?.spent, '');
  assert.equal(stripAnsi(card.quota!.text), '7d credits 31.8K');
  assert.equal(quotaOf(paying), 'credits 31.8K', 'the spent window gives its place to the balance');

  const broke = full({ has_credits: false, unlimited: false, balance: '0' });
  assert.ok(kinds(broke).includes('quota-exhausted'));
  assert.equal(statusCard(broke, NOW)!.quota?.label, undefined);
  assert.equal(stripAnsi(statusCard(broke, NOW)!.quota!.text), '7d 100%!');
  assert.equal(quotaOf(broke), '7d 100%');

  // Cut off by Codex's own word: credits or not, it is a stop.
  const cut = full({ has_credits: true, balance: '50' }, 'primary');
  assert.deepEqual(quotaState(cut.rateLimits, readQuotaWindows(cut.rateLimits, NOW)), { spent: true, credits: null });

  // Below full, the balance is no news: the window still has room.
  const partial = makeHudData({ rateLimits: { primary: { used_percent: 60, window_minutes: 300 }, credits: { has_credits: true, balance: '100' } } });
  assert.equal(statusCard(partial, NOW)!.quota?.label, undefined);
  assert.equal(quotaOf(partial), '5h 60%');

  assert.equal(formatCredits({ unlimited: true }), '∞');
  assert.equal(formatCredits({ unlimited: false, balance: 204.94 }), '205');
  assert.equal(readCredits({ credits: { has_credits: true, balance: 'n/a' } }), null, 'a balance that is not a number says nothing');
});

test('the bar names the quota window it reads', () => {
  for (const width of [120, 180]) {
    const text = stripAnsi(
      renderHud(makeHudData(), { width, showDetails: false, layout: { ...DEFAULT_LAYOUT, mode: 'compact' } })[0]
    );
    assert.match(text, / 5h 61% /, `${width}: ${text}`);
  }
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
