/** Hairline metro-map golden frames (40/62/80 cols, EN/ZH, colour/no-colour/ASCII), keyboard/mouse navigation, and ? help legend. Synthetic data only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  layoutMetroFlow,
  metroStationItem,
  renderMetroFlow,
  renderMetroLegend,
  runItem,
} from '../../dist/render/execution-metro.js';
import { PanelExecution } from '../../dist/panel/execution.js';
import { handleMonitorInput, initialMonitorState, monitorItemAt, renderMonitor } from '../../dist/render/monitor.js';
import { acceptsMonitorInput } from '../../dist/render/monitor-state.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { setLanguage, t as say } from '../../dist/render/i18n.js';
import { stripAnsi, theme, visualLength } from '../../dist/render/colors.js';
import { section } from '../../dist/render/workboard-rows.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);
const ago = (minutes) => NOW - minutes * 60_000;

function withMode({ theme: th = 'terminal', icons = 'unicode', lang = 'zh' }, fn) {
  const prevDisplay = setDisplayConfig({ theme: th, icons });
  const prevLang = setLanguage(lang);
  try {
    return fn();
  } finally {
    setDisplayConfig(prevDisplay);
    setLanguage(prevLang);
  }
}

/* ───────────────────────── synthetic scenarios matching docs/design/metro-map ───────────────────────── */

const tk = (id, deps, state, zh, en, lang, extra = {}) => ({
  id, num: id, kind: 'worker', deps, state, title: lang === 'zh' ? zh : en, role: 'imp', ...extra,
});
const reviewStation = (deps, lang, state = 'waiting') => ({
  id: 'rv', kind: 'review', deps, state, title: lang === 'zh' ? '队列评审' : 'Run review',
});
const acceptStation = (lang, state = 'waiting') => ({
  id: 'ac', kind: 'accept', deps: ['rv'], state, title: lang === 'zh' ? '负责人验收' : 'Lead acceptance',
});

function scenarios(lang) {
  const retry = {
    flow: 'retry', kind: 'queue', name: 'retry-queue', state: 'running', createdAt: ago(72), lastChangedId: '05',
    stations: [
      tk('01', [], 'done', '重试队列落盘格式', 'Retry queue file format', lang),
      tk('02', ['01'], 'done', '重启后按序恢复', 'Restore order on restart', lang),
      tk('03', ['02'], 'working', '死信视图', 'Dead-letter view', lang, { since: ago(14) }),
      tk('04', ['02'], 'asking', '退避参数放哪里', 'Where backoff settings live', lang, { since: ago(6) }),
      tk('05', ['02'], 'lease', '指标计数器', 'Metrics counters', lang, { since: ago(3) }),
      tk('06', ['03', '04', '05'], 'waiting', '端到端回放测试', 'End-to-end replay test', lang, { waits: '03,04,05' }),
      reviewStation(['06'], lang),
      acceptStation(lang),
    ],
  };

  const quota = {
    flow: 'quota', kind: 'queue', name: 'quota-core', state: 'running', createdAt: ago(47), lastChangedId: '02↻',
    stations: [
      tk('01', [], 'done', '账本读写接口', 'Ledger read/write API', lang),
      tk('02', ['01'], 'working', '并发扣减', 'Concurrent debit', lang, {
        gate: { n: 3, k: 2, state: 'failed' },
        repair: { state: 'working', round: '1/2', since: ago(4), role: 'imp', title: lang === 'zh' ? '并发扣减' : 'Concurrent debit' },
      }),
      tk('03', ['01'], 'working', '超额告警', 'Over-quota alert', lang, { gate: { n: 3, k: 3, state: 'working' }, since: ago(2) }),
      tk('04', ['02', '03'], 'waiting', '迁移旧账本', 'Migrate the old ledger', lang, { waits: '02,03' }),
      reviewStation(['04'], lang),
      acceptStation(lang),
    ],
  };

  const offline = {
    flow: 'offline', kind: 'queue', name: 'offline-sync', state: 'running', createdAt: ago(126), lastChangedId: '02',
    stations: [
      tk('01', [], 'done', '本地变更日志', 'Local change log', lang),
      tk('02', ['01'], 'held', '冲突裁决改规格', 'Conflict rule changes spec', lang, { since: ago(38) }),
      tk('03', ['01'], 'done', '增量上传', 'Incremental upload', lang),
      tk('05', ['02'], 'waiting', '冲突界面', 'Conflict screen', lang, { waits: '02' }),
      tk('04', ['03'], 'working', '重连回放', 'Replay after reconnect', lang, { since: ago(11) }),
      reviewStation(['05', '04'], lang),
      acceptStation(lang),
    ],
  };

  const batch = {
    flow: 'batch', kind: 'batch', name: 'sonic ×40', state: 'running', createdAt: ago(8), slots: '7/7', lastChangedId: 'pool',
    stations: [
      { id: 'pilot', kind: 'worker', deps: [], state: 'done', title: lang === 'zh' ? '探路 1/1' : 'Pilot 1/1' },
      {
        id: 'pool', kind: 'pool', deps: ['pilot'], state: 'working',
        counts: { done: 22, working: 7, failed: 1, waiting: 10 },
        title: lang === 'zh' ? '并发池 40 项 · 链接检查' : 'Pool of 40 · link check', since: ago(8), role: 'sonic',
      },
      { id: 'sum', kind: 'summary', deps: ['pool'], state: 'waiting', title: lang === 'zh' ? '汇总' : 'Summary' },
    ],
  };

  const member = (id, state, name, mins) => ({
    id, kind: 'worker', deps: [], state, role: 'oracle', ...(mins ? { since: ago(mins) } : {}),
    title: lang === 'zh' ? `成员 ${name}` : `Member ${name}`,
  });

  const council = {
    flow: 'council', kind: 'council', name: lang === 'zh' ? '跨机状态同步边界' : 'Cross-machine sync boundary',
    state: 'running', createdAt: ago(6), lastChangedId: 'm3',
    stations: [
      member('m1', 'done', 'fable'),
      member('m2', 'working', 'astra', 6),
      member('m3', 'done', 'carbon'),
      { id: 'syn', kind: 'synth', deps: ['m1', 'm2', 'm3'], state: 'waiting', title: lang === 'zh' ? '综合 (main)' : 'Synthesis (main)' },
    ],
  };

  const council5 = {
    ...council, flow: 'council5',
    stations: [
      member('m1', 'done', 'fable'),
      member('m2', 'working', 'astra', 6),
      member('m3', 'done', 'carbon'),
      member('m4', 'failed', 'neon'),
      member('m5', 'done', 'sol'),
      { id: 'syn', kind: 'synth', deps: ['m1', 'm2', 'm3', 'm4', 'm5'], state: 'waiting', title: lang === 'zh' ? '综合 (main)' : 'Synthesis (main)' },
    ],
  };

  const done = (id, deps) => tk(id, deps, 'done', '账本分片搬迁', 'Move a ledger shard', lang);
  const long = {
    flow: 'long', kind: 'queue', name: 'ledger-migration', state: 'running', createdAt: ago(248), lastChangedId: '09',
    stations: [
      done('01', []), done('02', ['01']), done('03', ['02']), done('04', ['02']),
      done('05', ['03', '04']), done('06', ['05']), done('07', ['06']),
      tk('08', ['07'], 'working', '归档读路径', 'Archive read path', lang, { since: ago(22) }),
      tk('09', ['07'], 'working', '双写校验', 'Verify dual writes', lang, { gate: { n: 4, k: 2, state: 'working' }, since: ago(5) }),
      tk('10', ['08', '09'], 'waiting', '切换写入', 'Switch writes', lang, { waits: '08,09' }),
      tk('11', ['10'], 'waiting', '回填历史', 'Backfill history', lang, { waits: '10' }),
      tk('12', ['11'], 'waiting', '删除旧表', 'Drop old tables', lang, { waits: '11' }),
      tk('13', ['12'], 'waiting', '更新文档', 'Update docs', lang, { waits: '12' }),
      tk('14', ['13'], 'waiting', '发布检查', 'Release check', lang, { waits: '13' }),
      reviewStation(['14'], lang),
      acceptStation(lang),
    ],
  };

  const land = {
    flow: 'land', kind: 'land', name: '04 Service worker cache', state: 'paused', createdAt: ago(9), lastChangedId: 'gate',
    stations: [
      { id: 'pick', kind: 'worker', deps: [], state: 'done', title: lang === 'zh' ? '拣选提交' : 'Cherry-pick' },
      {
        id: 'gate', kind: 'worker', deps: ['pick'], state: 'failed', gate: { n: 3, k: 2, state: 'failed' }, since: ago(9),
        title: lang === 'zh' ? 'npm 测试' : 'npm test',
        repair: { state: 'asking', round: '1/2', since: ago(2), role: 'imp', title: lang === 'zh' ? '缓存键冲突' : 'Cache key clash' },
      },
      { id: 'merge', kind: 'worker', deps: ['gate'], state: 'waiting', title: lang === 'zh' ? '合入' : 'Merge' },
    ],
  };

  return { retry, quota, offline, batch, council, council5, long, land };
}

function paintFlow(flow, cursorId, width, opts) {
  return withMode(opts, () => {
    const sel = cursorId ? metroStationItem(flow.flow, cursorId) : undefined;
    const rows = renderMetroFlow(flow, sel, width, NOW);
    for (const row of rows) {
      assert.equal(visualLength(row.text), width, `width ${width} mismatch: ${stripAnsi(row.text)}`);
      if (opts.theme === 'none') assert.equal(row.text, stripAnsi(row.text), 'none theme must emit no ANSI');
    }
    return rows;
  });
}

function paintStack(flows, firstCursorId, width, opts) {
  return withMode(opts, () => {
    const rows = [section(say('Workflow'), width, String(flows.length))];
    flows.forEach((f, i) => {
      const sel = i === 0 && firstCursorId ? metroStationItem(f.flow, firstCursorId) : undefined;
      rows.push(...renderMetroFlow(f, sel, width, NOW));
    });
    rows.push(...renderMetroLegend(flows, width));
    for (const row of rows) {
      assert.equal(visualLength(row.text), width, `stack width ${width} mismatch: ${stripAnsi(row.text)}`);
      if (opts.theme === 'none') assert.equal(row.text, stripAnsi(row.text), 'none theme must emit no ANSI');
    }
    return rows;
  });
}

const plain = (rows) => rows.map((r) => stripAnsi(r.text));

/* ───────────────────────── 1. Golden frames (40, 62, 80 cols; EN & ZH; colour/none/ASCII) ───────────────────────── */

test('Hairline golden frames match README/sample.html at 62, 40 and 80 columns across all 7 scenarios (ZH & EN)', () => {
  const zh = scenarios('zh');
  const en = scenarios('en');

  // s1: queue with 3 parallel tickets (working, asking, lease wait), cursor on 04.
  assert.deepEqual(plain(paintFlow(zh.retry, '04', 62, { lang: 'zh', theme: 'terminal' })), [
    '  ◉ 队列 retry-queue                            运行中 1时12分',
    '            ╭─────◉╌╌╌╌╌╮                                     ',
    '  ●───────●─┼─────?╌╌╌╌╌┼╌○╌╌╌╌╌╌╌◇╌╌╌╌╌╌╌☆                   ',
    '            ╰─────◷╌╌╌╌╌╯                                     ',
    '  ? 04 退避参数放哪里                             ⚒ 提问中 6分',
  ]);
  assert.deepEqual(plain(paintFlow(zh.retry, '04', 40, { lang: 'zh', theme: 'terminal' })), [
    '  ◉ 队列 retry-queue      运行中 1时12分',
    '           ╭────◉╌╌╌╌╮                  ',
    '  ●──────●─┼────?╌╌╌╌┼╌○╌╌╌╌╌╌◇╌╌╌╌╌╌☆  ',
    '           ╰────◷╌╌╌╌╯                  ',
    '  ? 04 退避参数放哪里       ⚒ 提问中 6分',
  ]);
  assert.deepEqual(plain(paintFlow(en.retry, '04', 80, { lang: 'en', theme: 'terminal' })), [
    '  ◉ Queue retry-queue                                              running 1h12m',
    '            ╭─────◉╌╌╌╌╌╮                                                       ',
    '  ●───────●─┼─────?╌╌╌╌╌┼╌○╌╌╌╌╌╌╌◇╌╌╌╌╌╌╌☆                                     ',
    '            ╰─────◷╌╌╌╌╌╯                                                       ',
    '  ? 04 Where backoff settings live                                   ⚒ asking 6m',
  ]);
  // No cursor on the map: detail line falls back to the station that changed last (05).
  assert.equal(
    plain(paintFlow(zh.retry, undefined, 62, { lang: 'zh', theme: 'terminal' })).at(-1),
    '  ◷ 05 指标计数器                                   ⚒ 等锁 3分',
  );

  // s2: failed gate + repair round + running gate.
  assert.deepEqual(plain(paintFlow(zh.quota, '02↻', 62, { lang: 'zh', theme: 'terminal' })), [
    '  ◉ 队列 quota-core                                运行中 47分',
    '  ●─┬─────‹▮▮◉›╌╌╌╌╌┬╌○╌╌╌╌╌╌╌◇╌╌╌╌╌╌╌☆                       ',
    '    ╰───┬─‹▮✗▯›╌┬╌╌╌╯                                         ',
    '        ╰───◉╌╌╌╯                                             ',
    '  ◉ 02 并发扣减                                 ⚒ 修复 1/2 4分',
  ]);
  assert.deepEqual(plain(paintFlow(en.quota, '02↻', 80, { lang: 'en', theme: 'terminal' })), [
    '  ◉ Queue quota-core                                                 running 47m',
    '  ●─┬─────‹▮▮◉›╌╌╌╌╌┬╌○╌╌╌╌╌╌╌◇╌╌╌╌╌╌╌☆                                         ',
    '    ╰───┬─‹▮✗▯›╌┬╌╌╌╯                                                           ',
    '        ╰───◉╌╌╌╯                                                               ',
    '  ◉ 02 Concurrent debit                                          ⚒ repair 1/2 4m',
  ]);
  assert.deepEqual(plain(paintFlow(zh.quota, '02↻', 40, { lang: 'zh', theme: 'none' })), [
    '  ◉ 队列 quota-core          运行中 47分',
    '  ●─┬─────‹▮▮◉›╌╌╌╌╌┬╌○╌╌╌╌╌╌╌◇╌╌╌╌╌╌╌☆ ',
    '    ╰───┬─‹▮✗▯›╌┬╌╌╌╯                   ',
    '        ╰─↻▸◉◂╌╌╯                       ',
    '  ◉ 02 并发扣减           ⚒ 修复 1/2 4分',
  ]);

  // s3: held station (`!`), dim branch ahead, other branch keeps moving.
  assert.deepEqual(plain(paintFlow(zh.offline, '02', 62, { lang: 'zh', theme: 'terminal' })), [
    '  ◉ 队列 offline-sync                           运行中 2时06分',
    '  ●─┬─────!╌╌╌╌╌╌╌○╌╌╌╌╌┬╌◇╌╌╌╌╌╌╌☆                           ',
    '    ╰─────●───────◉╌╌╌╌╌╯                                     ',
    '  ! 02 冲突裁决改规格                         ⚒ 挂起·等你 38分',
  ]);
  assert.deepEqual(plain(paintFlow(en.offline, '02', 80, { lang: 'en', theme: 'terminal' })), [
    '  ◉ Queue offline-sync                                             running 2h06m',
    '  ●─┬─────!╌╌╌╌╌╌╌○╌╌╌╌╌┬╌◇╌╌╌╌╌╌╌☆                                             ',
    '    ╰─────●───────◉╌╌╌╌╌╯                                                       ',
    '  ! 02 Conflict rule changes spec                             ⚒ held for you 38m',
  ]);

  // s4: batch pool as one group (3 rows in all).
  assert.deepEqual(plain(paintFlow(zh.batch, 'pool', 62, { lang: 'zh', theme: 'terminal' })), [
    '  ◉ 批次 sonic ×40                                槽位 7/7 8分',
    '  ●───────▐●×22 ◉×7 ✗×1 ○×10▌╌╌╌╌╌╌╌○                         ',
    '  ◉ 并发池 40 项 · 链接检查                       ϟ 工作中 8分',
  ]);
  assert.deepEqual(plain(paintFlow(zh.batch, 'pool', 40, { lang: 'zh', theme: 'none' })), [
    '  ◉ 批次 sonic ×40          槽位 7/7 8分',
    '  ●──────▸(●×22 ◉×7 ✗×1 ○×10)◂╌╌╌╌╌╌○   ',
    '  ◉ 并发池 40 项 · 链接检查   工作中 8分',
  ]);
  assert.deepEqual(plain(paintFlow(en.batch, 'pool', 80, { lang: 'en', theme: 'terminal' })), [
    '  ◉ Batch sonic ×40                                                 slots 7/7 8m',
    '  ●───────▐●×22 ◉×7 ✗×1 ○×10▌╌╌╌╌╌╌╌○                                           ',
    '  ◉ Pool of 40 · link check                                         ϟ working 8m',
  ]);

  // s5: council (3 members) and 5-member collapse (`council5`).
  assert.deepEqual(plain(paintFlow(zh.council, 'm2', 62, { lang: 'zh', theme: 'terminal' })), [
    '  ◉ 评议 跨机状态同步边界                           运行中 6分',
    '  ●─────╮                                                     ',
    '  ◉╌╌╌╌╌┼╌☆                                                   ',
    '  ●─────╯                                                     ',
    '  ◉ 成员 astra                                    ◈ 工作中 6分',
  ]);
  assert.deepEqual(plain(paintFlow(zh.council5, 'm4', 40, { lang: 'zh', theme: 'terminal' })), [
    '  ◉ 评议 跨机状态同步边界     运行中 6分',
    '    ◉╌╌╌╌╌╌╌╮                           ',
    '    ✗╌╌╌╌╌╌╌┼╌☆                         ',
    '  ▐●×3▌─────╯                           ',
    '  ✗ 成员 neon                     ◈ 失败',
  ]);
  assert.deepEqual(plain(paintFlow(en.council, 'm2', 80, { lang: 'en', theme: 'terminal' })), [
    '  ◉ Council Cross-machine sync boundary                               running 6m',
    '  ●─────╮                                                                       ',
    '  ◉╌╌╌╌╌┼╌☆                                                                     ',
    '  ●─────╯                                                                       ',
    '  ◉ Member astra                                                    ◈ working 6m',
  ]);

  // s6: long-run collapse (80 = unfolded, 62 = ●×7, 40 = ●×7 + ○×4).
  assert.deepEqual(plain(paintFlow(zh.long, '09', 80, { lang: 'zh', theme: 'terminal' })), [
    '  ◉ 队列 ledger-migration                                         运行中 4时08分',
    '  ●────●─┬──●──┬─●────●────●─┬────◉╌╌╌╌╌┬╌○╌╌╌╌○╌╌╌╌○╌╌╌╌○╌╌╌╌○╌╌╌╌◇╌╌╌╌☆       ',
    '         ╰──●──╯             ╰──‹▮◉▯▯›╌╌╯                                       ',
    '  ◉ 09 双写校验                                                   ⚒ 门禁 2/4 5分',
  ]);
  assert.deepEqual(plain(paintFlow(zh.long, '09', 62, { lang: 'zh', theme: 'terminal' })), [
    '  ◉ 队列 ledger-migration                       运行中 4时08分',
    '  ●×7─┬─────◉╌╌╌╌╌╌┬╌○╌╌╌╌╌○╌╌╌╌╌○╌╌╌╌╌○╌╌╌╌╌○╌╌╌╌╌◇╌╌╌╌╌☆    ',
    '      ╰───‹▮◉▯▯›╌╌╌╯                                          ',
    '  ◉ 09 双写校验                                 ⚒ 门禁 2/4 5分',
  ]);
  assert.deepEqual(plain(paintFlow(zh.long, '09', 40, { lang: 'zh', theme: 'terminal' })), [
    '  ◉ 队列 ledger-migration 运行中 4时08分',
    '  ●×7─┬────◉╌╌╌╌╌┬╌○╌╌╌╌○×4╌╌╌╌◇╌╌╌╌☆   ',
    '      ╰──‹▮◉▯▯›╌╌╯                      ',
    '  ◉ 09 双写校验           ⚒ 门禁 2/4 5分',
  ]);

  // s7: two flows + contextual legend (12 rows at 62 and 40, 11 rows at 80).
  const s7Zh62 = plain(paintStack([zh.retry, zh.land], '04', 62, { lang: 'zh', theme: 'terminal' }));
  assert.equal(s7Zh62.length, 12);
  assert.deepEqual(s7Zh62, [
    '工作流 ───────────────────────────────────────────────────── 2',
    '  ◉ 队列 retry-queue                            运行中 1时12分',
    '            ╭─────◉╌╌╌╌╌╮                                     ',
    '  ●───────●─┼─────?╌╌╌╌╌┼╌○╌╌╌╌╌╌╌◇╌╌╌╌╌╌╌☆                   ',
    '            ╰─────◷╌╌╌╌╌╯                                     ',
    '  ? 04 退避参数放哪里                             ⚒ 提问中 6分',
    '  ‖ 落地 04 Service worker cache                    已暂停 9分',
    '  ●─────┬─‹▮✗▯›╌┬╌╌╌╌╌○                                       ',
    '        ╰───?╌╌╌╯                                             ',
    '  ✗ npm 测试                                 门禁 失败 2/3 9分',
    '  ? 提问  ✗ 失败  ── 修复  ‹▮◉▯› 门禁  ◷ 等锁  ◇◈◆ 评审       ',
    '  ☆✪★ 验收                                                    ',
  ]);
  assert.deepEqual(plain(paintStack([en.retry, en.land], '04', 62, { lang: 'en', theme: 'terminal' })), [
    'Workflow ─────────────────────────────────────────────────── 2',
    '  ◉ Queue retry-queue                            running 1h12m',
    '            ╭─────◉╌╌╌╌╌╮                                     ',
    '  ●───────●─┼─────?╌╌╌╌╌┼╌○╌╌╌╌╌╌╌◇╌╌╌╌╌╌╌☆                   ',
    '            ╰─────◷╌╌╌╌╌╯                                     ',
    '  ? 04 Where backoff settings live                 ⚒ asking 6m',
    '  ‖ Land 04 Service worker cache                     paused 9m',
    '  ●─────┬─‹▮✗▯›╌┬╌╌╌╌╌○                                       ',
    '        ╰───?╌╌╌╯                                             ',
    '  ✗ npm test                                gate failed 2/3 9m',
    '  ? asking  ✗ failed  ── repair  ‹▮◉▯› gate  ◷ lease          ',
    '  ◇◈◆ review  ☆✪★ accept                                      ',
  ]);
  assert.deepEqual(plain(paintStack([en.retry, en.land], '04', 40, { lang: 'en', theme: 'terminal' })), [
    'Workflow ───────────────────────────── 2',
    '  ◉ Queue retry-queue      running 1h12m',
    '           ╭────◉╌╌╌╌╮                  ',
    '  ●──────●─┼────?╌╌╌╌┼╌○╌╌╌╌╌╌◇╌╌╌╌╌╌☆  ',
    '           ╰────◷╌╌╌╌╯                  ',
    '  ? 04 Where backoff setting…  asking 6m',
    '  ‖ Land 04 Service worker cache  paused',
    '  ●─────┬─‹▮✗▯›╌┬╌╌╌╌╌○                 ',
    '        ╰───?╌╌╌╯                       ',
    '  ✗ npm test          gate failed 2/3 9m',
    '  ? asking  ✗ failed  ── repair         ',
    '  ‹▮◉▯› gate  ◷ lease  ◇◈◆ review       ',
  ]);
  assert.deepEqual(plain(paintStack([en.retry, en.land], '04', 80, { lang: 'en', theme: 'terminal' })), [
    'Workflow ───────────────────────────────────────────────────────────────────── 2',
    '  ◉ Queue retry-queue                                              running 1h12m',
    '            ╭─────◉╌╌╌╌╌╮                                                       ',
    '  ●───────●─┼─────?╌╌╌╌╌┼╌○╌╌╌╌╌╌╌◇╌╌╌╌╌╌╌☆                                     ',
    '            ╰─────◷╌╌╌╌╌╯                                                       ',
    '  ? 04 Where backoff settings live                                   ⚒ asking 6m',
    '  ‖ Land 04 Service worker cache                                       paused 9m',
    '  ●─────┬─‹▮✗▯›╌┬╌╌╌╌╌○                                                         ',
    '        ╰───?╌╌╌╯                                                               ',
    '  ✗ npm test                                                  gate failed 2/3 9m',
    '  ? asking  ✗ failed  ── repair  ‹▮◉▯› gate  ◷ lease  ◇◈◆ review  ☆✪★ accept    ',
  ]);
});

test('no-colour and ASCII (icons=text) modes match Hairline rules at 40, 62 and 80 columns', () => {
  const zh = scenarios('zh');
  const en = scenarios('en');

  // No-colour Unicode: ▸ ◂ cursor brackets, ↻ repair mark, solid vs dashed lines, zero ANSI.
  assert.deepEqual(plain(paintStack([zh.retry, zh.land], '04', 62, { lang: 'zh', theme: 'none' })), [
    '工作流 ───────────────────────────────────────────────────── 2',
    '  ◉ 队列 retry-queue                            运行中 1时12分',
    '            ╭─────◉╌╌╌╌╌╮                                     ',
    '  ●───────●─┼────▸?◂╌╌╌╌┼╌○╌╌╌╌╌╌╌◇╌╌╌╌╌╌╌☆                   ',
    '            ╰─────◷╌╌╌╌╌╯                                     ',
    '  ? 04 退避参数放哪里                             ⚒ 提问中 6分',
    '  ‖ 落地 04 Service worker cache                    已暂停 9分',
    '  ●─────┬─‹▮✗▯›╌┬╌╌╌╌╌○                                       ',
    '        ╰──↻?╌╌╌╯                                             ',
    '  ✗ npm 测试                                 门禁 失败 2/3 9分',
    '  ? 提问  ✗ 失败  ↻ 修复  ‹▮◉▯› 门禁  ◷ 等锁  ◇◈◆ 评审        ',
    '  ☆✪★ 验收                                                    ',
  ]);

  // ASCII mode (`icons=text`, `theme=none`): =/-, |/|, ./', ><, %, {#@.}, no ×, ○◉● listed in legend.
  assert.deepEqual(plain(paintStack([zh.retry, zh.land], '04', 62, { lang: 'zh', theme: 'none', icons: 'text' })), [
    '工作流 ----------------------------------------------------- 2',
    '  @ 队列 retry-queue                            运行中 1时12分',
    '            .=====@-----.                                     ',
    '  +=======+=|====>?<----|-o-------r-------a                   ',
    '            \'=====~-----\'                                     ',
    '  ? 04 退避参数放哪里                               提问中 6分',
    '  = 落地 04 Service worker cache                    已暂停 9分',
    '  +=====.={#x.}-.-----o                                       ',
    '        \'==%?---\'                                             ',
    '  x npm 测试                                 门禁 失败 2/3 9分',
    '  ? 提问  x 失败  % 修复  {#@.} 门禁  ~ 等锁  r R 评审        ',
    '  a A 验收  @ 进行  + 完成  o 未开始                          ',
  ]);
  assert.deepEqual(plain(paintFlow(zh.long, '09', 40, { lang: 'zh', theme: 'none', icons: 'text' })), [
    '  @ 队列 ledger-migration 运行中 4时08分',
    '  +7=.====@-----.-o----o4----r----a     ',
    '     \'=>{#@..}<-\'                       ',
    '  @ 09 双写校验             门禁 2/4 5分',
  ]);
  assert.deepEqual(plain(paintFlow(en.batch, 'pool', 62, { lang: 'en', theme: 'none', icons: 'text' })), [
    '  @ Batch sonic ×40                               slots 7/7 8m',
    '  +======>(+22 @7 x1 o10)<------o                             ',
    '  @ Pool of 40 · link check                         working 8m',
  ]);

  // Colour token verification (Hairline neutral line + state colours + surfaces).
  withMode({ lang: 'en', theme: 'mocha', icons: 'unicode' }, () => {
    const rows = renderMetroFlow(en.retry, metroStationItem('retry', '04'), 62, NOW);
    const b = theme.board;
    // Travelled line in muted, ahead in frame, working in active, asking in askTitle, cursor in selected.
    assert.ok(rows[2].text.includes(b.muted('───────')), 'travelled line uses board.muted');
    assert.ok(rows[2].text.includes(b.frame('╌╌╌╌╌╌╌')), 'ahead line uses board.frame');
    assert.ok(rows[2].text.includes(b.askTitle('?')), 'asking station uses board.askTitle');
    assert.ok(rows[2].text.includes(b.selected(b.muted('─'))), 'cursor neighbour uses board.selected');
    assert.ok(rows[1].text.includes(b.active('◉')), 'working station uses board.active');
    const qRows = renderMetroFlow(en.quota, metroStationItem('quota', '02↻'), 62, NOW);
    assert.ok(qRows[1].text.includes(b.opinion('◉')), 'running gate step uses board.opinion');
    assert.ok(qRows[2].text.includes(b.danger('✗')), 'failed gate step uses board.danger');
    assert.ok(qRows[3].text.includes(b.stalled('╰──')), 'repair line uses board.stalled');
  });
});

test('? help page carries the full Workflow metro-map legend and map keys across 40/62/80 cols and modes', () => {
  for (const width of [40, 62, 80]) {
    for (const lang of ['en', 'zh']) {
      for (const mode of [{ theme: 'none', icons: 'unicode' }, { theme: 'mocha', icons: 'unicode' }, { theme: 'none', icons: 'text' }]) {
        const frame = withMode({ ...mode, lang }, () =>
          renderMonitor({ state: { ...initialMonitorState(), activeTab: 'execution', help: {} }, width, height: 60, nowMs: NOW }),
        );
        for (const line of frame.lines) {
          assert.equal(visualLength(line), width, `help ${lang} ${width} ${mode.theme}/${mode.icons}`);
          if (mode.theme === 'none') assert.equal(line, stripAnsi(line));
        }
        const allHelp = frame.workboard.rows.map((r) => stripAnsi(r.text)).join('\n');
        assert.ok(allHelp.includes(lang === 'zh' ? '工作流图' : 'Workflow map'), `missing map keys in help ${lang}`);
        if (mode.icons === 'text') {
          assert.ok(allHelp.includes('{#@.}'), 'ASCII help legend lists gate');
          assert.ok(allHelp.includes('+6 o4'), 'ASCII help legend lists folds');
        } else {
          assert.ok(allHelp.includes('‹▮◉▯›'), 'Unicode help legend lists gate');
          assert.ok(allHelp.includes('●×6 ○×4'), 'Unicode help legend lists folds');
        }
      }
    }
  }
  // Full legend helper matches sample.html `all: true` layout.
  const fullZh = withMode({ lang: 'zh', theme: 'terminal', icons: 'unicode' }, () =>
    renderMetroLegend([scenarios('zh').retry, scenarios('zh').land], 62, { all: true }).map((r) => stripAnsi(r.text)),
  );
  assert.deepEqual(fullZh, [
    '  ? 提问  ! 等你定  ✗ 失败  ── 修复  ‹▮◉▯› 门禁  ◷ 等锁       ',
    '  ◍ 停滞  ⊘ 已停止  ◌ 未知  ◇◈◆ 评审  ☆✪★ 验收  ◉ 进行  ● 完成',
    '  ○ 未开始  ●×6 ○×4 折叠                                      ',
  ]);
});

/* ───────────────────────── 2. Keyboard & per-cell mouse input tests ───────────────────────── */

test('keyboard and mouse: station cursor, lane moves, Tab switching, Enter targets, and per-cell hits', () => {
  const jobTarget = (id) => ({
    target: { kind: 'worker', laneId: 'inv:1', workerId: `thin-job:${id}` },
    dir: `/synthetic/hud/jobs/${id}`,
    tab: true,
  });
  const J3 = 'j0000000000000003', J4 = 'j0000000000000004', J5 = 'j0000000000000005', J_CARD = 'j0000000000000099';
  const flow1 = 'q1111111111111111', flow2 = 'b2222222222222222';
  const executionView = {
    root: '/synthetic/proj',
    complete: true,
    screens: new Map(),
    endedJobs: [],
    jobs: [{
      jobId: J_CARD,
      dir: `/synthetic/hud/jobs/${J_CARD}`,
      phase: 'running',
      hasScreen: false,
      worker: { id: `thin-job:${J_CARD}`, laneId: 'inv:1', role: 'sonic', state: 'working', headless: true, startedAt: ago(2), settledAt: null, briefTitle: 'Synthetic card worker' },
    }],
    runs: [
      {
        flow: flow1, kind: 'queue', label: 'retry-queue', unattended: false, state: 'working',
        createdAt: ago(72), updatedAt: ago(3),
        steps: [{ key: 'tickets', state: 'running' }, { key: 'review', state: 'waiting' }, { key: 'accept', state: 'waiting' }],
        tickets: [
          { ticket: '01', role: 'imp', stage: 'landed', title: 'File format' },
          { ticket: '02', role: 'imp', stage: 'landed', title: 'Restart order' },
          { ticket: '03', role: 'imp', stage: 'worker', title: 'Dead-letter view', since: ago(14), jobId: J3, execJob: jobTarget(J3) },
          { ticket: '04', role: 'imp', stage: 'worker', asking: true, title: 'Backoff settings', since: ago(6), jobId: J4, execJob: jobTarget(J4) },
          { ticket: '05', role: 'imp', stage: 'land-gate', landProgress: { kind: 'lease', since: ago(3) }, title: 'Metrics counters', since: ago(3), jobId: J5, execJob: jobTarget(J5) },
          { ticket: '06', role: 'imp', stage: 'blocked', blockers: ['03', '04', '05'], title: 'Replay test' },
        ],
        queueWaves: {
          prefix: [
            { ticket: '01', role: 'imp', stage: 'landed', title: 'File format' },
            { ticket: '02', role: 'imp', stage: 'landed', title: 'Restart order' },
          ],
          current: [
            { ticket: '03', role: 'imp', stage: 'worker', title: 'Dead-letter view', since: ago(14), jobId: J3, execJob: jobTarget(J3) },
            { ticket: '04', role: 'imp', stage: 'worker', asking: true, title: 'Backoff settings', since: ago(6), jobId: J4, execJob: jobTarget(J4) },
            { ticket: '05', role: 'imp', stage: 'land-gate', landProgress: { kind: 'lease', since: ago(3) }, title: 'Metrics counters', since: ago(3), jobId: J5, execJob: jobTarget(J5) },
          ],
          blocked: [[{ ticket: '06', role: 'imp', stage: 'blocked', blockers: ['03', '04', '05'], title: 'Replay test' }]],
        },
        todo: [], decisions: [], reviews: [], heldCount: 0, repairRounds: 0,
      },
      {
        flow: flow2, kind: 'batch', label: 'sonic ×10', unattended: false, state: 'working',
        createdAt: ago(5), updatedAt: ago(1),
        steps: [], tickets: [], todo: [], decisions: [], reviews: [], heldCount: 0, repairRounds: 0,
        batch: { flow: flow2, role: 'sonic', count: 10, state: 'working', slots: 4, totals: { done: 5, running: 3, waiting: 2, failed: 0, cancelled: 0 } },
        metro: {
          stations: [
            { id: 'pool', kind: 'pool', state: 'working', role: 'sonic', pool: { done: 5, working: 3, waiting: 2 }, count: 10, changedAt: ago(1) },
            { id: 'summary', kind: 'summary', state: 'waiting', blockers: ['pool'] },
          ],
          edges: [{ from: 'pool', to: 'summary' }],
          lastChangedId: 'pool',
        },
      },
    ],
  };

  const decoder = new WorkbenchInputDecoder('workboard');
  const draw = (state, width = 62) => withMode({ lang: 'en', theme: 'none', icons: 'unicode' }, () =>
    renderMonitor({ state, width, height: 30, nowMs: NOW, execution: executionView, projectName: 'demo' }));
  const send = (state, raw, width = 62) => {
    const frame = draw(state, width);
    const input = typeof raw === 'string'
      ? (raw === '\x1b' ? { type: 'key', key: 'escape' } : decoder.push(Buffer.from(raw))[0])
      : raw;
    if (input.type === 'key') assert.equal(acceptsMonitorInput(frame.state, input), true);
    return handleMonitorInput(frame.state, input, { frame, nowMs: NOW });
  };

  // Start on Execution: default cursor is on first flow header; detail line shows changed-last (05, newest since).
  let state = { ...initialMonitorState(), activeTab: 'execution' };
  let frame = draw(state);
  assert.equal(frame.state.execution.cursor, runItem(flow1));
  assert.match(frame.lines.map(stripAnsi).join('\n'), /◷ 05 Metrics counters/);

  // Enter on the flow header opens Run Detail; Esc returns to header.
  const runDetail = send(state, '\r').state;
  assert.deepEqual(runDetail.subpage, { kind: 'run-detail', flow: flow1, scroll: 0 });
  state = send(runDetail, '\x1b').state;
  assert.equal(state.subpage, undefined);
  assert.equal(state.execution.cursor, runItem(flow1));

  // On flow header (not on map): ← switches tabs to Project; Tab brings us back to Execution.
  const leftFromHeader = send(state, '\x1b[D').state;
  assert.equal(leftFromHeader.activeTab, 'project');

  // ↓ from flow header enters the map on topmost lane (lane 0: ticket 03).
  state = send(state, '\x1b[B').state;
  assert.equal(state.execution.cursor, metroStationItem(flow1, '03'));
  assert.match(draw(state).lines.map(stripAnsi).join('\n'), /◉ 03 Dead-letter view/);

  // ↓ moves across lanes: lane 0 (03) -> lane 1 (04) -> lane 2 (05) -> leaves map to flow2 header!
  state = send(state, '\x1b[B').state;
  assert.equal(state.execution.cursor, metroStationItem(flow1, '04'));
  assert.match(draw(state).lines.map(stripAnsi).join('\n'), /\? 04 Backoff settings/);
  state = send(state, '\x1b[B').state;
  assert.equal(state.execution.cursor, metroStationItem(flow1, '05'));
  state = send(state, '\x1b[B').state;
  assert.equal(state.execution.cursor, runItem(flow2));

  // ↑ from flow2 header re-enters flow1 on bottommost lane (05) -> 04 -> 03 -> leaves upward to flow1 header!
  state = send(state, '\x1b[A').state;
  assert.equal(state.execution.cursor, metroStationItem(flow1, '05'));
  state = send(state, '\x1b[A').state;
  assert.equal(state.execution.cursor, metroStationItem(flow1, '04'));
  state = send(state, '\x1b[A').state;
  assert.equal(state.execution.cursor, metroStationItem(flow1, '03'));
  state = send(state, '\x1b[A').state;
  assert.equal(state.execution.cursor, runItem(flow1));

  // Step onto middle lane (04): ←/→ move between stations (never switch tabs, even at ends!).
  state = send(send(state, '\x1b[B').state, '\x1b[B').state;
  assert.equal(state.execution.cursor, metroStationItem(flow1, '04'));
  state = send(state, '\x1b[D').state;
  assert.equal(state.execution.cursor, metroStationItem(flow1, '02'));
  assert.equal(state.activeTab, 'execution');
  state = send(state, '\x1b[D').state;
  assert.equal(state.execution.cursor, metroStationItem(flow1, '01'));
  // Left at leftmost station stays on map and does NOT switch tabs.
  state = send(state, '\x1b[D').state;
  assert.equal(state.activeTab, 'execution');
  assert.equal(state.execution.cursor, metroStationItem(flow1, '01'));
  // Right walks 01 -> 02 -> 04 (keeps lane 1) -> 06 -> review -> accept.
  for (const id of ['02', '04', '06', 'review', 'accept']) {
    state = send(state, '\x1b[C').state;
    assert.equal(state.execution.cursor, metroStationItem(flow1, id));
  }
  // Right at rightmost station stays on map.
  state = send(state, '\x1b[C').state;
  assert.equal(state.activeTab, 'execution');
  assert.equal(state.execution.cursor, metroStationItem(flow1, 'accept'));

  // Tab and Shift-Tab ALWAYS switch tabs even while the cursor is on a map station!
  assert.equal(send(state, '\t').state.activeTab, 'control');
  assert.equal(send(state, '\x1b[Z').state.activeTab, 'project');

  // Enter on a non-worker station (accept) opens station inspection built from run facts; Esc returns.
  const acceptOpen = send(state, '\r').state;
  assert.equal(acceptOpen.subpage?.kind, 'station-detail');
  assert.equal(acceptOpen.subpage?.flow, flow1);
  assert.equal(acceptOpen.subpage?.stationId, 'accept');
  assert.match(draw(acceptOpen).lines.map(stripAnsi).join('\n'), /Lead acceptance/);
  state = send(acceptOpen, '\x1b').state;
  assert.equal(state.subpage, undefined);
  assert.equal(state.execution.cursor, metroStationItem(flow1, 'accept'));

  // Move to 06 (future ticket): Enter opens station inspection with blockers.
  state = send(send(state, '\x1b[D').state, '\x1b[D').state;
  assert.equal(state.execution.cursor, metroStationItem(flow1, '06'));
  const futureOpen = send(state, '\r').state;
  assert.equal(futureOpen.subpage?.kind, 'station-detail');
  assert.equal(futureOpen.subpage?.stationId, '06');
  const futureText = draw(futureOpen).lines.map(stripAnsi).join('\n');
  assert.match(futureText, /Replay test/);
  assert.match(futureText, /03, 04, 05/);
  state = send(futureOpen, '\x1b').state;

  // Move to 04 (has execJob + live tab): g/P/H work and Enter opens Inspector; Esc returns to 04.
  state = send(state, '\x1b[D').state;
  assert.equal(state.execution.cursor, metroStationItem(flow1, '04'));
  assert.deepEqual(send(state, 'g').action, { type: 'focus-job-tab', dir: `/synthetic/hud/jobs/${J4}` });
  const insp = send(state, '\r').state;
  assert.deepEqual([insp.subpage.kind, insp.subpage.from, insp.subpage.target.workerId],
    ['inspector', 'execution', `thin-job:${J4}`]);
  state = send(insp, '\x1b').state;
  assert.equal(state.subpage, undefined);
  assert.equal(state.execution.cursor, metroStationItem(flow1, '04'));

  // Per-cell mouse hits: click 03 selects 03, click 05 selects 05, second click on 05 opens Inspector, empty cell is no-op.
  frame = draw(state);
  const pane = frame.panes.find((p) => p.id === 'agents');
  const findCoords = (flowId, stationId) => {
    const targetItem = metroStationItem(flowId, stationId);
    for (let i = 0; i < pane.rows.length; i++) {
      const hit = pane.rows[i].metroStations?.find((s) => s.item === targetItem);
      if (hit) return { x: pane.x + hit.x, y: pane.y + (pane.edge ?? 0) + i - pane.offset, hit };
    }
    throw new Error(`station not found: ${flowId}:${stationId}`);
  };
  const c3 = findCoords(flow1, '03');
  const c5 = findCoords(flow1, '05');
  const cPool = findCoords(flow2, 'pool');
  const cFuture = findCoords(flow1, '06');
  assert.equal(monitorItemAt(pane, c3.x, c3.y), metroStationItem(flow1, '03'));
  assert.equal(monitorItemAt(pane, c5.x, c5.y), metroStationItem(flow1, '05'));
  assert.equal(monitorItemAt(pane, c3.x + 2, c3.y), undefined, 'line cell between stations is not a station hit');

  state = send(state, { type: 'mouse', button: 'left', x: c3.x, y: c3.y }).state;
  assert.equal(state.execution.cursor, metroStationItem(flow1, '03'));
  // Clicking empty cell leaves cursor unchanged.
  state = send(state, { type: 'mouse', button: 'left', x: c3.x + 2, y: c3.y }).state;
  assert.equal(state.execution.cursor, metroStationItem(flow1, '03'));
  // Click 05 selects 05; second click opens 05's Inspector.
  state = send(state, { type: 'mouse', button: 'left', x: c5.x, y: c5.y }).state;
  assert.equal(state.execution.cursor, metroStationItem(flow1, '05'));
  assert.equal(state.subpage, undefined);
  const clickedInsp = send(state, { type: 'mouse', button: 'left', x: c5.x, y: c5.y }).state;
  assert.equal(clickedInsp.subpage.target.workerId, `thin-job:${J5}`);

  // Click + second click on batch pool opens station inspection with counts and slots; Enter does too.
  state = send(state, { type: 'mouse', button: 'left', x: cPool.x, y: cPool.y }).state;
  assert.equal(state.execution.cursor, metroStationItem(flow2, 'pool'));
  assert.equal(state.subpage, undefined);
  const clickedPool = send(state, { type: 'mouse', button: 'left', x: cPool.x, y: cPool.y }).state;
  assert.equal(clickedPool.subpage?.kind, 'station-detail');
  assert.equal(clickedPool.subpage?.stationId, 'pool');
  const poolText = draw(clickedPool).lines.map(stripAnsi).join('\n');
  assert.match(poolText, /Pool of 10/);
  assert.match(poolText, /3\/4/);
  assert.equal(send(state, '\r').state.subpage?.stationId, 'pool');

  // Second click on future ticket opens station inspection too.
  state = send(state, { type: 'mouse', button: 'left', x: cFuture.x, y: cFuture.y }).state;
  const clickedFuture = send(state, { type: 'mouse', button: 'left', x: cFuture.x, y: cFuture.y }).state;
  assert.equal(clickedFuture.subpage?.kind, 'station-detail');
  assert.equal(clickedFuture.subpage?.stationId, '06');
});

/* ───────────────────────── 3. Layout edge cases & exec-page/04 model interface ───────────────────────── */

test('layout handles inline repair fallback, cycles, skip-a-column edges, and changedAt selection cleanly', () => {
  // Inline repair fallback when all 3 lanes are occupied (no free neighbouring lane for repair spur).
  const crowded = {
    flow: 'crowded', kind: 'queue', name: 'full-lanes', state: 'running', createdAt: ago(10),
    stations: [
      { id: '01', num: '01', kind: 'worker', deps: [], state: 'done', title: 'Root' },
      { id: '02', num: '02', kind: 'worker', deps: ['01'], state: 'working', title: 'Lane A' },
      { id: '03', num: '03', kind: 'worker', deps: ['01'], state: 'working', title: 'Lane B' },
      {
        id: '04', num: '04', kind: 'worker', deps: ['01'], state: 'working', title: 'Lane C',
        gate: { n: 2, k: 2, state: 'failed' },
        repair: { state: 'working', round: '1/2', role: 'imp', title: 'Lane C' },
      },
      { id: '05', num: '05', kind: 'worker', deps: ['02', '03', '04'], state: 'waiting', title: 'Join' },
    ],
  };
  const crowdedRows = paintFlow(crowded, '04↻', 62, { lang: 'en', theme: 'none' });
  assert.ok(crowdedRows.length <= 5, 'stays within 3 map lanes + header + detail');
  assert.ok(plain(crowdedRows).some((l) => l.includes('↻')), 'inline repair shows ↻ in none mode');

  // Cycle safety + changedAt selection.
  const cyclic = {
    flow: 'cyc', kind: 'graph', name: 'cyclic', state: 'running', createdAt: ago(5),
    stations: [
      { id: 'a', kind: 'worker', state: 'done', title: 'A' },
      { id: 'b', kind: 'worker', state: 'working', title: 'B' },
    ],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
  };
  assert.doesNotThrow(() => layoutMetroFlow(cyclic, 62, false));

  const changedFlow = {
    flow: 'laned', kind: 'queue', name: 'changed-at', state: 'running', createdAt: ago(15),
    stations: [
      { id: 's1', num: '01', kind: 'worker', state: 'done', title: 'Base' },
      { id: 's2', num: '02', kind: 'worker', state: 'working', title: 'Top', changedAt: ago(4) },
      { id: 's3', num: '03', kind: 'worker', state: 'asking', title: 'Bottom', changedAt: ago(1) },
      { id: 's4', num: '04', kind: 'worker', state: 'waiting', title: 'Merge', waits: '02,03' },
    ],
    edges: [{ from: 's1', to: 's2' }, { from: 's1', to: 's3' }, { from: 's2', to: 's4' }, { from: 's3', to: 's4' }],
  };
  const changedRows = paintFlow(changedFlow, undefined, 62, { lang: 'en', theme: 'none' });
  assert.match(plain(changedRows).at(-1), /\? 03 Bottom/, 'changedAt picks most recently changed station');
});

/* ───────────────────────── 4. Collector metro integration, junctions, multi-round repair, and station inspection ───────────────────────── */

function putJson(file, value) {
  fs.mkdirSync(join(file, '..'), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

test('collection + renderMonitor: new-format queue renders parallel roots, single-root branch, 2/3 failed gate, newest landing detail, and main hand-back', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'exec-metro-e2e-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hud = join(root, 'hud'), project = join(root, 'project'), flows = join(hud, 'flows');
  const iso = (mins) => new Date(NOW - mins * 60_000).toISOString();
  const id = (p, n) => `${p}${n.toString(16).padStart(16, '0')}`;
  const addJob = (n, state, receipt = {}, statusExtra = {}) => {
    const jid = id('j', n), dir = join(hud, 'jobs', jid);
    putJson(join(dir, 'job.json'), {
      job: jid, cwd: project, project_root: project, role: 'imp', headless: true,
      dispatch_exit_code: 0, created_at: iso(40 - n), ...receipt,
    });
    putJson(join(dir, 'STATUS.json'), { state, started_at: iso(25 - n), ...statusExtra });
    fs.writeFileSync(join(dir, 'brief.md'), `# ${receipt.ticket ?? `0${n}`}: ${receipt.title ?? `Task ${n}`}\n`);
    return jid;
  };

  const jRoot2 = addJob(1, 'done', { ticket: 'demo/02', title: 'Independent root beta' }, { settled_at: iso(1) });
  const jRoot1 = addJob(2, 'done', { ticket: 'demo/01', title: 'Independent root alpha' }, { settled_at: iso(20) });
  const jGate = addJob(3, 'done', { ticket: 'demo/03', title: 'Worker on alpha only' }, { started_at: iso(10), settled_at: iso(6) });
  const jRep1 = addJob(4, 'working', { ticket: 'demo/03', title: 'Repair alpha gate' }, { started_at: iso(5) });
  const fGate = id('f', 3);
  putJson(join(flows, `${fGate}.json`), {
    flow: fGate, job: jGate, pane: '', task: false,
    wt: { root: project, main_root: project, branch: 'wt/03' },
    config: { base: 'main', gate: ['build', 'unit', 'lint'], after: [], push: false },
    state: 'running', step: 'repair 1', pid: process.pid, start: '1',
    created_at: iso(9), updated_at: iso(5), step_started_at: iso(5), source_sha: 'a'.repeat(40),
    repairs: [{ step: 'gate[2]: unit', job: jRep1, outcome: 'waiting for worker', started_at: iso(5), changed_at: iso(5) }],
    timings: [{ step: 'cherry-pick', ok: true, ms: 5 }, { step: 'gate[2]: unit', ok: false, ms: 15 }],
  });
  const qFlow = id('q', 1);
  putJson(join(flows, `${qFlow}.json`), {
    flow: qFlow, root: project, project_root: project, feature: 'demo', pane: '', task: false, max_parallel: 2,
    created_at: iso(30), updated_at: iso(1), state: 'working', handback_to: 'main',
    steps: { tickets: { state: 'running', changed_at: iso(30) }, review: { state: 'waiting' }, accept: { state: 'waiting' } },
    tickets: [
      { ticket: 'demo/02', path: join(project, '.scratch/demo/02.md'), role: 'imp', job: jRoot2, landed: true, blockers: [], landed_at: iso(1), changed_at: iso(1) },
      { ticket: 'demo/01', path: join(project, '.scratch/demo/01.md'), role: 'imp', job: jRoot1, landed: true, blockers: [], landed_at: iso(20), changed_at: iso(20) },
      { ticket: 'demo/03', path: join(project, '.scratch/demo/03.md'), role: 'imp', job: jGate, land: fGate, blockers: ['demo/01'] },
    ],
    queued: [{ ticket: 'demo/04', blockers: ['demo/02'] }],
  });

  const execution = new PanelExecution(hud, null, {}, () => {});
  t.after(() => execution.dispose());
  execution.sync(project, false);
  await execution.refresh(undefined, NOW);
  const view = execution.view(project);

  const draw = (state, opts = { lang: 'en', theme: 'none', icons: 'unicode' }) => withMode(opts, () =>
    renderMonitor({ state, width: 62, height: 24, nowMs: NOW, execution: view, projectName: 'demo' }));
  const baseState = { ...initialMonitorState(), activeTab: 'execution' };
  const frame = draw(baseState);
  const allStations = frame.workboard.rows.flatMap((r) => r.metroStations ?? []);
  const byId = new Map(allStations.map((s) => [s.stationId, s]));

  // Two independent landed roots sit in parallel in column 0 on distinct lanes (never in series).
  assert.equal(byId.get('demo/02').col, 0);
  assert.equal(byId.get('demo/01').col, 0);
  assert.notEqual(byId.get('demo/02').lane, byId.get('demo/01').lane);

  // Worker 03 sits in column 1 on the exact lane of root 01 only, with failed 2/3 gate (‹▮✗▯›) and repair spur.
  assert.equal(byId.get('demo/03').col, 1);
  assert.equal(byId.get('demo/03').lane, byId.get('demo/01').lane);
  assert.equal(byId.get('demo/04').col, 1);
  assert.equal(byId.get('demo/04').lane, byId.get('demo/02').lane);
  const text = frame.lines.map(stripAnsi).join('\n');
  assert.ok(text.includes('‹▮✗▯›'), `expected 2/3 failed gate glyph:\n${text}`);

  // Default detail line shows the newest change: demo/02 landed 1m ago (newer than worker start 10m & repair 5m).
  assert.match(text, /● 02 Independent root beta\s+⚒ landed 1m/);

  // Cursor on demo/03 shows real gate index/total 2/3 (not 1/1).
  const onGate = draw({ ...baseState, execution: { cursor: metroStationItem(qFlow, 'demo/03'), scroll: 0 } });
  assert.match(onGate.lines.map(stripAnsi).join('\n'), /gate failed 2\/3/);

  // Main hand-back is labeled main (not Lead acceptance) in both EN and ZH, and opens station inspection on Enter & second click.
  const onAccept = { ...baseState, execution: { cursor: metroStationItem(qFlow, 'accept'), scroll: 0 } };
  const acceptEn = draw(onAccept, { lang: 'en', theme: 'none', icons: 'unicode' });
  const acceptZh = draw(onAccept, { lang: 'zh', theme: 'none', icons: 'unicode' });
  assert.match(acceptEn.lines.map(stripAnsi).join('\n'), /Hand-back \(main\)/);
  assert.doesNotMatch(acceptEn.lines.map(stripAnsi).join('\n'), /Lead acceptance/);
  assert.match(acceptZh.lines.map(stripAnsi).join('\n'), /交回 \(main\)/);
  assert.doesNotMatch(acceptZh.lines.map(stripAnsi).join('\n'), /负责人验收/);

  const decoder = new WorkbenchInputDecoder('workboard');
  const enterAccept = handleMonitorInput(acceptEn.state, decoder.push(Buffer.from('\r'))[0], { frame: acceptEn, nowMs: NOW }).state;
  assert.equal(enterAccept.subpage?.kind, 'station-detail');
  assert.equal(enterAccept.subpage?.stationId, 'accept');
  const acceptDetailText = draw(enterAccept).lines.map(stripAnsi).join('\n');
  assert.match(acceptDetailText, /Hand-back \(main\)/);
  assert.match(acceptDetailText, /Seat\s+main/);

  const pane = acceptEn.panes.find((p) => p.id === 'agents');
  const acceptRowIdx = pane.rows.findIndex((r) => r.metroStations?.some((s) => s.stationId === 'accept'));
  const acceptHit = pane.rows[acceptRowIdx].metroStations.find((s) => s.stationId === 'accept');
  const clickAccept = handleMonitorInput(acceptEn.state, {
    type: 'mouse', button: 'left', x: pane.x + acceptHit.x, y: pane.y + acceptRowIdx - pane.offset,
  }, { frame: acceptEn, nowMs: NOW }).state;
  assert.equal(clickAccept.subpage?.kind, 'station-detail');
  assert.equal(clickAccept.subpage?.stationId, 'accept');
});

test('round 1 and round 2 repairs both render and are selectable via keyboard, mouse and Enter (spur and inline)', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'exec-metro-rep2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hud = join(root, 'hud'), project = join(root, 'project'), flows = join(hud, 'flows');
  const iso = (mins) => new Date(NOW - mins * 60_000).toISOString();
  const id = (p, n) => `${p}${n.toString(16).padStart(16, '0')}`;
  const addJob = (n, state, receipt = {}, statusExtra = {}) => {
    const jid = id('j', n), dir = join(hud, 'jobs', jid);
    putJson(join(dir, 'job.json'), {
      job: jid, cwd: project, project_root: project, role: 'imp', headless: true,
      dispatch_exit_code: 0, created_at: iso(40 - n), ...receipt,
    });
    putJson(join(dir, 'STATUS.json'), { state, started_at: iso(25 - n), ...statusExtra });
    fs.writeFileSync(join(dir, 'brief.md'), `# ${receipt.ticket ?? `0${n}`}: Repair test ${n}\n`);
    return jid;
  };

  const jSrc = addJob(1, 'done', { ticket: 'rep/01' }, { settled_at: iso(15) });
  const jRep1 = addJob(2, 'done', { ticket: 'rep/01' }, { started_at: iso(12), settled_at: iso(8) });
  const jRep2 = addJob(3, 'working', { ticket: 'rep/01' }, { started_at: iso(2) });
  const fLand = id('f', 1);
  putJson(join(flows, `${fLand}.json`), {
    flow: fLand, job: jSrc, pane: '', task: false,
    wt: { root: project, main_root: project, branch: 'wt/rep01' },
    config: { base: 'main', gate: ['build', 'unit', 'lint'], after: [], push: false },
    state: 'running', step: 'repair 2', pid: process.pid, start: '1',
    created_at: iso(15), updated_at: iso(2), step_started_at: iso(2), source_sha: 'b'.repeat(40),
    repairs: [
      { step: 'gate[2]: unit', job: jRep1, outcome: 'failed at gate[2]: unit', started_at: iso(12), changed_at: iso(6) },
      { step: 'gate[2]: unit', job: jRep2, outcome: 'waiting for worker', started_at: iso(2), changed_at: iso(2) },
    ],
    timings: [{ step: 'cherry-pick', ok: true, ms: 5 }, { step: 'gate[2]: unit', ok: false, ms: 20 }],
  });
  const qFlow = id('q', 2);
  putJson(join(flows, `${qFlow}.json`), {
    flow: qFlow, root: project, project_root: project, feature: 'rep', pane: '', task: false, max_parallel: 2,
    created_at: iso(30), updated_at: iso(2), state: 'working',
    steps: { tickets: { state: 'running', changed_at: iso(30) }, review: { state: 'waiting' }, accept: { state: 'waiting' } },
    tickets: [{ ticket: 'rep/01', path: join(project, '.scratch/rep/01.md'), role: 'imp', job: jSrc, land: fLand, blockers: [] }],
  });

  const execution = new PanelExecution(hud, null, {}, () => {});
  t.after(() => execution.dispose());
  execution.sync(project, false);
  await execution.refresh(undefined, NOW);
  const view = execution.view(project);

  const draw = (state) => withMode({ lang: 'en', theme: 'none', icons: 'unicode' }, () =>
    renderMonitor({ state, width: 62, height: 24, nowMs: NOW, execution: view, projectName: 'demo' }));
  const decoder = new WorkbenchInputDecoder('workboard');
  const send = (state, raw) => {
    const frame = draw(state);
    const input = typeof raw === 'string' ? decoder.push(Buffer.from(raw))[0] : raw;
    return handleMonitorInput(frame.state, input, { frame, nowMs: NOW });
  };

  let state = { ...initialMonitorState(), activeTab: 'execution' };
  const frame = draw(state);
  const stations = frame.workboard.rows.flatMap((r) => r.metroStations ?? []);
  const r1 = stations.find((s) => s.stationId === 'rep/01↻');
  const r2 = stations.find((s) => s.stationId === 'rep/01↻2');
  assert.ok(r1 && r2, 'both round 1 and round 2 repair stations exist');
  assert.equal(r1.lane, r2.lane, 'both repair rounds sit on the repair line');
  assert.ok(r1.x < r2.x, 'round 1 sits to the left of round 2');

  // Default detail line follows round 2 (newest change); moving ←/→ switches between round 1 and round 2.
  assert.match(frame.lines.map(stripAnsi).join('\n'), /repair 2\/2 2m/);
  state = { ...state, execution: { cursor: metroStationItem(qFlow, 'rep/01↻'), scroll: 0 } };
  assert.match(draw(state).lines.map(stripAnsi).join('\n'), /repair failed 1\/2 6m/);
  assert.equal(send(state, '\r').state.subpage?.target?.workerId, `thin-job:${jRep1}`);

  state = send(state, '\x1b[C').state;
  assert.equal(state.execution.cursor, metroStationItem(qFlow, 'rep/01↻2'));
  assert.equal(send(state, '\r').state.subpage?.target?.workerId, `thin-job:${jRep2}`);
  state = send(state, '\x1b[D').state;
  assert.equal(state.execution.cursor, metroStationItem(qFlow, 'rep/01↻'));

  // Inline fallback when all 3 lanes are full also renders and selects both rounds.
  const crowded2 = {
    flow: 'crowded2', kind: 'queue', name: 'full-lanes-2', state: 'running', createdAt: ago(15),
    stations: [
      { id: '01', num: '01', kind: 'worker', deps: [], state: 'done', title: 'Root' },
      { id: '02', num: '02', kind: 'worker', deps: ['01'], state: 'working', title: 'Lane A' },
      { id: '03', num: '03', kind: 'worker', deps: ['01'], state: 'working', title: 'Lane B' },
      {
        id: '04', num: '04', kind: 'worker', deps: ['01'], state: 'working', title: 'Lane C',
        gate: { n: 3, k: 2, state: 'failed' },
        repairs: [
          { id: '04↻', state: 'failed', round: '1/2', role: 'imp', title: 'Lane C' },
          { id: '04↻2', state: 'working', round: '2/2', role: 'imp', title: 'Lane C' },
        ],
      },
      { id: '05', num: '05', kind: 'worker', deps: ['02', '03', '04'], state: 'waiting', title: 'Join' },
    ],
  };
  const inlineRows = paintFlow(crowded2, '04↻2', 62, { lang: 'en', theme: 'none' });
  const inlineIds = inlineRows.flatMap((r) => r.metroStations ?? []).map((s) => s.stationId);
  assert.ok(inlineIds.includes('04↻') && inlineIds.includes('04↻2'), `both inline rounds selectable: ${inlineIds}`);
});

test('skip-a-column and crossing graphs render through reduceMetroLanes with junctions and preserved blockers', () => {
  const skipFlow = {
    flow: 'skip', kind: 'graph', name: 'skip-graph', state: 'running', createdAt: ago(10), lastChangedId: '04',
    stations: [
      { id: '01', kind: 'worker', state: 'done', title: 'Root 1' },
      { id: '02', kind: 'worker', state: 'done', title: 'Root 2' },
      { id: '03', kind: 'worker', state: 'working', title: 'Middle' },
      { id: '04', kind: 'worker', state: 'waiting', title: 'Sink', blockers: ['01', '03'] },
    ],
    edges: [{ from: '02', to: '03' }, { from: '01', to: '04' }, { from: '03', to: '04' }],
  };
  const skipLayout = layoutMetroFlow(skipFlow, 62, false);
  assert.equal(skipLayout.junctions.length, 1, 'skip-a-column edge renders via reduceMetroLanes shared junction');
  const skipRows = paintFlow(skipFlow, '04', 62, { lang: 'en', theme: 'none' });
  assert.match(plain(skipRows).at(-1), /←01,03/, 'original blockers stay visible on detail line');

  const k22 = {
    flow: 'k22', kind: 'graph', name: 'crossing-k22', state: 'running', createdAt: ago(8), lastChangedId: 'C',
    stations: [
      { id: 'A', kind: 'worker', state: 'done', title: 'A' },
      { id: 'B', kind: 'worker', state: 'done', title: 'B' },
      { id: 'C', kind: 'worker', state: 'waiting', title: 'C' },
      { id: 'D', kind: 'worker', state: 'waiting', title: 'D' },
    ],
    edges: [{ from: 'A', to: 'C' }, { from: 'A', to: 'D' }, { from: 'B', to: 'C' }, { from: 'B', to: 'D' }],
  };
  const k22Layout = layoutMetroFlow(k22, 62, false);
  assert.equal(k22Layout.junctions.length, 1, 'unavoidable crossing renders via shared junction');
  const k22Plain = plain(paintFlow(k22, 'C', 62, { lang: 'en', theme: 'none' }));
  assert.ok(k22Plain[1].includes('┬') && k22Plain[2].includes('┴'), `expected junction box glyphs:\n${k22Plain.join('\n')}`);
  assert.match(k22Plain.at(-1), /←A,B/);

  // ASCII mode handles junctions cleanly too.
  const k22Ascii = plain(paintFlow(k22, 'C', 62, { lang: 'en', theme: 'none', icons: 'text' }));
  assert.ok(k22Ascii[1].includes('.') && k22Ascii[2].includes("'"));
});

test('Enter and second click on folded groups (done×, wait×, overflow pool) and flow header open inspection / Run Detail', () => {
  const flowId = 'qfolded0000000001';
  const stations = [
    ...Array.from({ length: 6 }, (_, i) => ({ id: `0${i + 1}`, kind: 'worker', state: 'done', title: `Done ${i + 1}` })),
    { id: '07', kind: 'worker', state: 'working', title: 'Active A' },
    { id: '08', kind: 'worker', state: 'working', title: 'Active B' },
    { id: '09', kind: 'worker', state: 'waiting', title: 'Wait 1' },
    { id: '10', kind: 'worker', state: 'waiting', title: 'Wait 2' },
    { id: '11', kind: 'worker', state: 'waiting', title: 'Wait 3' },
    { id: '12', kind: 'worker', state: 'waiting', title: 'Wait 4' },
    { id: 'review', kind: 'review', state: 'waiting' },
    { id: 'accept', kind: 'accept', state: 'waiting', label: 'main' },
  ];
  const edges = [
    { from: '01', to: '02' }, { from: '02', to: '03' }, { from: '03', to: '04' }, { from: '04', to: '05' }, { from: '05', to: '06' },
    { from: '06', to: '07' }, { from: '06', to: '08' },
    { from: '07', to: '09' }, { from: '08', to: '09' },
    { from: '09', to: '10' }, { from: '10', to: '11' }, { from: '11', to: '12' },
    { from: '12', to: 'review' }, { from: 'review', to: 'accept' },
  ];
  const executionView = {
    root: '/synthetic/proj', complete: true, screens: new Map(), endedJobs: [], jobs: [],
    runs: [{
      flow: flowId, kind: 'queue', label: 'long-fold', unattended: false, state: 'working', acceptanceSeat: 'main',
      createdAt: ago(60), updatedAt: ago(2),
      steps: [{ key: 'tickets', state: 'running' }, { key: 'review', state: 'waiting' }, { key: 'accept', state: 'waiting' }],
      tickets: stations.filter((s) => s.kind === 'worker').map((s) => ({
        ticket: s.id, role: 'imp', title: s.title, stage: s.state === 'done' ? 'landed' : s.state === 'working' ? 'worker' : 'queued',
      })),
      metro: { stations, edges, lastChangedId: '07' },
      todo: [], decisions: [], reviews: [], heldCount: 0, repairRounds: 0,
    }],
  };

  const draw = (state) => withMode({ lang: 'en', theme: 'none', icons: 'unicode' }, () =>
    renderMonitor({ state, width: 40, height: 24, nowMs: NOW, execution: executionView, projectName: 'demo' }));
  const decoder = new WorkbenchInputDecoder('workboard');
  const base = { ...initialMonitorState(), activeTab: 'execution' };
  const frame = draw(base);
  const pane = frame.panes.find((p) => p.id === 'agents');

  // Second click on flow header opens Run Detail.
  const headerIdx = pane.rows.findIndex((r) => r.item === runItem(flowId));
  const clickHeader = handleMonitorInput(frame.state, {
    type: 'mouse', button: 'left', x: pane.x + 4, y: pane.y + headerIdx - pane.offset,
  }, { frame, nowMs: NOW }).state;
  assert.deepEqual(clickHeader.subpage, { kind: 'run-detail', flow: flowId, scroll: 0 });

  // Both folded groups (`done×` and `wait×`) exist at 40 cols and open inspection listing their member items on Enter & second click.
  for (const [groupId, expectedMember] of [['done×', 'Done 1'], ['wait×', 'Wait 4']]) {
    const onGroup = { ...base, execution: { cursor: metroStationItem(flowId, groupId), scroll: 0 } };
    const fGroup = draw(onGroup);
    const enterRes = handleMonitorInput(fGroup.state, decoder.push(Buffer.from('\r'))[0], { frame: fGroup, nowMs: NOW }).state;
    assert.equal(enterRes.subpage?.kind, 'station-detail');
    assert.equal(enterRes.subpage?.stationId, groupId);
    const detailText = draw(enterRes).lines.map(stripAnsi).join('\n');
    assert.ok(detailText.includes(expectedMember), `${groupId} inspection missing ${expectedMember}:\n${detailText}`);

    const gPane = fGroup.panes.find((p) => p.id === 'agents');
    const rIdx = gPane.rows.findIndex((r) => r.metroStations?.some((s) => s.stationId === groupId));
    const hit = gPane.rows[rIdx].metroStations.find((s) => s.stationId === groupId);
    const clickRes = handleMonitorInput(fGroup.state, {
      type: 'mouse', button: 'left', x: gPane.x + hit.x, y: gPane.y + rIdx - gPane.offset,
    }, { frame: fGroup, nowMs: NOW }).state;
    assert.equal(clickRes.subpage?.kind, 'station-detail');
    assert.equal(clickRes.subpage?.stationId, groupId);
  }
});

/* ───────────────────────── 5. Horizontal viewport, scoped Station Detail, terminal theme escaping, unknown pool ───────────────────────── */

test('40-column horizontal viewport keeps every station reachable by ←/→ and mouse on 22-step chain and 32-step graph', () => {
  const decoder = new WorkbenchInputDecoder('workboard');
  const makeRunView = (flowId, label, stations, edges, lastChangedId) => ({
    root: '/synthetic/proj', complete: true, screens: new Map(), endedJobs: [], jobs: [],
    runs: [{
      flow: flowId, kind: 'graph', label, unattended: false, state: 'working',
      createdAt: ago(30), updatedAt: ago(1),
      steps: [], tickets: [], todo: [], decisions: [], reviews: [], heldCount: 0, repairRounds: 0,
      metro: { stations, edges, lastChangedId },
    }],
  });

  // 1) 22-step alternating worker/reviewer chain (no station folds away).
  const chainFlow = 'gchain22000000001';
  const chainStations = Array.from({ length: 22 }, (_, i) => ({
    id: `s${i + 1}`,
    kind: i % 2 === 0 ? 'worker' : 'review',
    state: i < 10 ? 'done' : i === 10 ? 'working' : 'waiting',
    title: `Step ${i + 1}`,
    role: i % 2 === 0 ? 'imp' : 'reviewer',
  }));
  const chainEdges = Array.from({ length: 21 }, (_, i) => ({ from: `s${i + 1}`, to: `s${i + 2}` }));
  const chainView = makeRunView(chainFlow, 'chain-22', chainStations, chainEdges, 's1');

  const renderAt40 = (view, state, opts = { lang: 'en', theme: 'terminal', icons: 'unicode' }) => {
    const frame = withMode(opts, () =>
      renderMonitor({ state, width: 40, height: 24, nowMs: NOW, execution: view, projectName: 'demo' }));
    for (const line of frame.lines) {
      assert.equal(visualLength(line), 40, `line width must stay 40: ${stripAnsi(line)}`);
      if (opts.theme === 'none') assert.equal(line, stripAnsi(line));
    }
    return frame;
  };
  const sendAt40 = (view, state, raw, opts = { lang: 'en', theme: 'terminal', icons: 'unicode' }) => {
    const frame = renderAt40(view, state, opts);
    const input = typeof raw === 'string'
      ? (raw === '\x1b' ? { type: 'key', key: 'escape' } : decoder.push(Buffer.from(raw))[0])
      : raw;
    return { frame, ...handleMonitorInput(frame.state, input, { frame, nowMs: NOW }) };
  };

  // Walk → from s1 to s22 and ← back to s1; verify off-screen indicators and exact 40-col lines.
  let state = { ...initialMonitorState(), activeTab: 'execution', execution: { cursor: metroStationItem(chainFlow, 's1'), scroll: 0 } };
  const startFrame = renderAt40(chainView, state);
  const startMapRow = startFrame.workboard.rows.find((r) => r.metroStations?.length);
  assert.equal(startMapRow.metroStations.length, 22, 'all 22 stations stay in metroStations');
  assert.ok(stripAnsi(startMapRow.text).endsWith('»'), `right edge marker shown at start: ${stripAnsi(startMapRow.text)}`);
  assert.ok(!stripAnsi(startMapRow.text).startsWith('«'), 'no left edge marker at start');

  // ASCII mode uses > / < markers and exact width 40.
  const asciiStart = renderAt40(chainView, state, { lang: 'en', theme: 'none', icons: 'text' });
  const asciiRow = asciiStart.workboard.rows.find((r) => r.metroStations?.length);
  assert.ok(stripAnsi(asciiRow.text).endsWith('>'), `ASCII right edge marker shown: ${stripAnsi(asciiRow.text)}`);

  const visitedForward = ['s1'];
  let sawBothEdges = false;
  for (let i = 1; i < 22; i++) {
    const step = sendAt40(chainView, state, '\x1b[C');
    state = step.state;
    const f = renderAt40(chainView, state);
    const mapText = stripAnsi(f.workboard.rows.find((r) => r.metroStations?.length).text);
    if (mapText.startsWith('«') && mapText.endsWith('»')) sawBothEdges = true;
    visitedForward.push(state.execution.cursor.split(':').at(-1));
  }
  assert.deepEqual(visitedForward, chainStations.map((s) => s.id), '→ reaches all 22 stations');
  assert.ok(sawBothEdges, 'mid-chain frames show both « and » edge markers');
  const endFrame = renderAt40(chainView, state);
  const endMapText = stripAnsi(endFrame.workboard.rows.find((r) => r.metroStations?.length).text);
  assert.ok(endMapText.startsWith('«'), `left edge marker shown at end: ${endMapText}`);
  assert.ok(!endMapText.endsWith('»'), `no right edge marker at end: ${endMapText}`);
  assert.match(endFrame.lines.map(stripAnsi).join('\n'), /Step 22/);

  // Walk ← all the way back to s1.
  const visitedBack = [state.execution.cursor.split(':').at(-1)];
  for (let i = 1; i < 22; i++) {
    state = sendAt40(chainView, state, '\x1b[D').state;
    visitedBack.push(state.execution.cursor.split(':').at(-1));
  }
  assert.deepEqual(visitedBack, [...chainStations].reverse().map((s) => s.id), '← returns through all 22 stations');

  // Mouse-only reachability: pan right via clicking » edge markers until s22 is visible, click s22 twice -> Station Detail, then pan back via «.
  state = { ...initialMonitorState(), activeTab: 'execution', execution: { cursor: metroStationItem(chainFlow, 's1'), scroll: 0 } };
  for (let clicks = 0; clicks < 10; clicks++) {
    const f = renderAt40(chainView, state);
    const pane = f.panes.find((p) => p.id === 'agents');
    const rowIdx = pane.rows.findIndex((r) => r.metroStations?.length);
    const row = pane.rows[rowIdx];
    const s22 = row.metroStations.find((s) => s.stationId === 's22');
    const y = pane.y + (pane.edge ?? 0) + rowIdx - pane.offset;
    if (!s22.offscreen) {
      state = handleMonitorInput(f.state, { type: 'mouse', button: 'left', x: pane.x + s22.x, y }, { frame: f, nowMs: NOW }).state;
      assert.equal(state.execution.cursor, metroStationItem(chainFlow, 's22'));
      const f2 = renderAt40(chainView, state);
      const pane2 = f2.panes.find((p) => p.id === 'agents');
      const rIdx2 = pane2.rows.findIndex((r) => r.metroStations?.length);
      const hit2 = pane2.rows[rIdx2].metroStations.find((s) => s.stationId === 's22');
      const y2 = pane2.y + (pane2.edge ?? 0) + rIdx2 - pane2.offset;
      const opened = handleMonitorInput(f2.state, { type: 'mouse', button: 'left', x: pane2.x + hit2.x, y: y2 }, { frame: f2, nowMs: NOW }).state;
      assert.equal(opened.subpage?.kind, 'station-detail');
      assert.equal(opened.subpage?.stationId, 's22');
      break;
    }
    const rightEdge = row.metroEdges?.find((e) => e.side === 'right');
    assert.ok(rightEdge, 'right edge marker clickable while s22 is off-screen');
    assert.equal(monitorItemAt(pane, pane.x + rightEdge.x, y), rightEdge.target.item);
    state = handleMonitorInput(f.state, { type: 'mouse', button: 'left', x: pane.x + rightEdge.x, y }, { frame: f, nowMs: NOW }).state;
  }
  assert.equal(state.execution.cursor, metroStationItem(chainFlow, 's22'), 'mouse reached s22');

  // Pan back left via clicking « edge markers until s1 is visible, then click s1.
  for (let clicks = 0; clicks < 10; clicks++) {
    const f = renderAt40(chainView, state);
    const pane = f.panes.find((p) => p.id === 'agents');
    const rowIdx = pane.rows.findIndex((r) => r.metroStations?.length);
    const row = pane.rows[rowIdx];
    const s1 = row.metroStations.find((s) => s.stationId === 's1');
    const y = pane.y + (pane.edge ?? 0) + rowIdx - pane.offset;
    if (!s1.offscreen) {
      state = handleMonitorInput(f.state, { type: 'mouse', button: 'left', x: pane.x + s1.x, y }, { frame: f, nowMs: NOW }).state;
      break;
    }
    const leftEdge = row.metroEdges?.find((e) => e.side === 'left');
    assert.ok(leftEdge, 'left edge marker clickable while s1 is off-screen');
    state = handleMonitorInput(f.state, { type: 'mouse', button: 'left', x: pane.x + leftEdge.x, y }, { frame: f, nowMs: NOW }).state;
  }
  assert.equal(state.execution.cursor, metroStationItem(chainFlow, 's1'), 'mouse returned to s1');

  // 2) 32-step graph (28 sequential stages + two 2-way parallel diamonds = 32 stations, mixed kinds/states).
  const graphFlow = 'ggraph32000000001';
  const gStations = [];
  const gEdges = [];
  let prev = [];
  let idx = 1;
  const addNode = (kind, stateVal) => {
    const id = `n${idx++}`;
    gStations.push({ id, kind, state: stateVal, title: `Node ${id}`, role: kind === 'review' ? 'reviewer' : 'imp' });
    return id;
  };
  for (let step = 0; step < 30; step++) {
    if (step === 8 || step === 20) {
      const a = addNode('worker', step === 8 ? 'working' : 'waiting');
      const b = addNode('review', step === 8 ? 'working' : 'waiting');
      for (const p of prev) { gEdges.push({ from: p, to: a }, { from: p, to: b }); }
      prev = [a, b];
    } else {
      const kind = step === 29 ? 'accept' : step % 2 === 1 ? 'review' : 'worker';
      const st = step < 8 ? 'done' : step === 9 ? 'working' : 'waiting';
      const id = addNode(kind, st);
      for (const p of prev) gEdges.push({ from: p, to: id });
      prev = [id];
    }
  }
  assert.equal(gStations.length, 32);
  const graphView = makeRunView(graphFlow, 'graph-32', gStations, gEdges, 'n1');
  let gState = { ...initialMonitorState(), activeTab: 'execution', execution: { cursor: metroStationItem(graphFlow, 'n1'), scroll: 0 } };
  const gStart = renderAt40(graphView, gState, { lang: 'en', theme: 'none', icons: 'unicode' });
  const all32 = gStart.workboard.rows.flatMap((r) => r.metroStations ?? []);
  assert.equal(all32.length, 32, 'all 32 graph stations present and none folded away');
  assert.ok(gStart.workboard.rows.some((r) => r.metroEdges?.some((e) => e.side === 'right')), '32-step graph shows right overflow marker');

  // Reach every station of the 32-step graph via ←/→ and ↑/↓.
  const reached = new Set(['n1']);
  for (let c = 0; c < 35; c++) {
    const curId = gState.execution.cursor.split(':').at(-1);
    reached.add(curId);
    // Probe adjacent lanes at this column too.
    for (const arrow of ['\x1b[B', '\x1b[A']) {
      const probe = sendAt40(graphView, gState, arrow, { lang: 'en', theme: 'none', icons: 'unicode' }).state;
      if (probe.execution.cursor?.startsWith(`project:exec-run:${graphFlow}:`)) {
        reached.add(probe.execution.cursor.split(':').at(-1));
      }
    }
    const next = sendAt40(graphView, gState, '\x1b[C', { lang: 'en', theme: 'none', icons: 'unicode' }).state;
    if (next.execution.cursor === gState.execution.cursor) break;
    gState = next;
  }
  assert.equal(reached.size, 32, `all 32 graph stations reachable by keyboard (got ${reached.size})`);
  assert.equal(gState.execution.cursor, metroStationItem(graphFlow, 'n32'), '→ reaches final station n32');

  // Reach n32 from n1 by mouse clicks only on the 32-step graph.
  gState = { ...initialMonitorState(), activeTab: 'execution', execution: { cursor: metroStationItem(graphFlow, 'n1'), scroll: 0 } };
  let clickedN32 = false;
  for (let clicks = 0; clicks < 12; clicks++) {
    const f = renderAt40(graphView, gState);
    const pane = f.panes.find((p) => p.id === 'agents');
    let hitRow = -1;
    let target = undefined;
    for (let i = 0; i < pane.rows.length; i++) {
      const st = pane.rows[i].metroStations?.find((s) => s.stationId === 'n32');
      if (st && !st.offscreen) { hitRow = i; target = st; break; }
    }
    if (target) {
      const y = pane.y + (pane.edge ?? 0) + hitRow - pane.offset;
      gState = handleMonitorInput(f.state, { type: 'mouse', button: 'left', x: pane.x + target.x, y }, { frame: f, nowMs: NOW }).state;
      clickedN32 = gState.execution.cursor === metroStationItem(graphFlow, 'n32');
      break;
    }
    const edgeRowIdx = pane.rows.findIndex((r) => r.metroEdges?.some((e) => e.side === 'right'));
    assert.ok(edgeRowIdx >= 0, 'right edge marker present until n32 enters view');
    const edge = pane.rows[edgeRowIdx].metroEdges.find((e) => e.side === 'right');
    const y = pane.y + (pane.edge ?? 0) + edgeRowIdx - pane.offset;
    gState = handleMonitorInput(f.state, { type: 'mouse', button: 'left', x: pane.x + edge.x, y }, { frame: f, nowMs: NOW }).state;
  }
  assert.ok(clickedN32, 'mouse reached final station n32 in 32-step graph');
});

test('Station Detail scopes hand-back/choices/hold/reason to its step and emits no literal \\x1b in terminal theme', () => {
  const flowId = 'qscope00000000001';
  const baseRun = {
    flow: flowId, kind: 'queue', label: 'scoped-detail', unattended: false, state: 'paused', acceptanceSeat: 'main',
    createdAt: ago(25), updatedAt: ago(2),
    steps: [
      { key: 'tickets', state: 'running' },
      { key: 'review', state: 'waiting' },
      { key: 'accept', state: 'waiting' },
    ],
    handback: {
      step: 'tickets',
      choices: ['resume', 'stop'],
      kind: 'blocker',
      ticket: 'demo/01',
      question: 'Needs schema sign-off?',
    },
    held: { reason: 'Ticket 01 blocked on schema sign-off', at: new Date(ago(2)).toISOString(), kind: 'blocker' },
    reason: 'Ticket 01 blocked on schema sign-off',
    tickets: [
      { ticket: 'demo/01', role: 'imp', stage: 'held', holdTag: 'blocker', reason: 'Ticket 01 blocked on schema sign-off', title: 'Schema migration' },
      { ticket: 'demo/02', role: 'imp', stage: 'queued', blockers: ['demo/01'], title: 'Consumer update' },
    ],
    metro: {
      stations: [
        { id: 'demo/01', kind: 'worker', state: 'held', role: 'imp', holdTag: 'blocker', reason: 'Ticket 01 blocked on schema sign-off', title: 'Schema migration' },
        { id: 'demo/02', kind: 'worker', state: 'waiting', role: 'imp', blockers: ['demo/01'], title: 'Consumer update' },
        { id: 'review', kind: 'review', state: 'waiting', role: 'reviewer', blockers: ['demo/02'] },
        { id: 'accept', kind: 'accept', state: 'waiting', role: 'lead', label: 'main', blockers: ['review'] },
      ],
      edges: [
        { from: 'demo/01', to: 'demo/02' },
        { from: 'demo/02', to: 'review' },
        { from: 'review', to: 'accept' },
      ],
      lastChangedId: 'demo/01',
    },
    todo: [], decisions: [], reviews: [], heldCount: 1, repairRounds: 0,
  };
  const view = { root: '/synthetic/proj', complete: true, screens: new Map(), endedJobs: [], jobs: [], runs: [baseRun] };

  // 1) Future accept station during a tickets-step blocker shows NO hand-back, choices, hold or reason from that blocker.
  const acceptState = {
    ...initialMonitorState(),
    activeTab: 'execution',
    subpage: { kind: 'station-detail', flow: flowId, stationId: 'accept', scroll: 0 },
  };
  const acceptFrame = withMode({ lang: 'en', theme: 'terminal', icons: 'unicode' }, () =>
    renderMonitor({ state: acceptState, width: 62, height: 24, nowMs: NOW, execution: view, projectName: 'demo' }));
  const acceptRaw = acceptFrame.lines.join('\n');
  const acceptPlain = stripAnsi(acceptRaw);
  assert.doesNotMatch(acceptPlain, /Hand-back\s+tickets/, 'future accept must not show tickets-step hand-back');
  assert.doesNotMatch(acceptPlain, /Needs schema sign-off/, 'future accept must not show tickets blocker question');
  assert.doesNotMatch(acceptPlain, /resume · stop/, 'future accept must not show tickets blocker choices');
  assert.doesNotMatch(acceptPlain, /Ticket 01 blocked/, 'future accept must not show tickets blocker hold/reason');
  assert.ok(!acceptRaw.includes('\\x1b'), 'terminal theme Station Detail (accept) must not contain literal \\x1b');
  assert.ok(!acceptPlain.includes('\x1b'), 'stripped Station Detail must contain no ESC');

  // 2) Run Detail keeps whole-run context (held + reason).
  const runDetailState = {
    ...initialMonitorState(),
    activeTab: 'execution',
    subpage: { kind: 'run-detail', flow: flowId, scroll: 0 },
  };
  const runDetailPlain = withMode({ lang: 'en', theme: 'terminal', icons: 'unicode' }, () =>
    renderMonitor({ state: runDetailState, width: 62, height: 24, nowMs: NOW, execution: view, projectName: 'demo' }))
    .lines.map(stripAnsi).join('\n');
  assert.match(runDetailPlain, /Ticket 01 blocked on schema sign-off/, 'Run Detail retains run-level hold/reason');

  // 3) Station Detail in terminal & mocha themes on stations with roles emits NO literal \x1b escape text.
  for (const stationId of ['demo/01', 'review', 'accept']) {
    for (const th of ['terminal', 'mocha']) {
      const st = { ...initialMonitorState(), activeTab: 'execution', subpage: { kind: 'station-detail', flow: flowId, stationId, scroll: 0 } };
      const frame = withMode({ lang: 'en', theme: th, icons: 'unicode' }, () =>
        renderMonitor({ state: st, width: 62, height: 24, nowMs: NOW, execution: view, projectName: 'demo' }));
      for (const line of frame.lines) assert.equal(visualLength(line), 62);
      const raw = frame.lines.join('\n');
      assert.ok(!raw.includes('\\x1b'), `${stationId} (${th}) must not print literal \\x1b:\n${raw}`);
      assert.ok(!stripAnsi(raw).includes('\x1b'), `${stationId} (${th}) stripped text must not contain ESC`);
      assert.match(stripAnsi(raw), /Role\s+\S+/, `${stationId} (${th}) still renders Role row`);
    }
  }

  // 4) Active accept-step hand-back DOES show its own hand-back, choices, hold and reason.
  const acceptRun = {
    ...baseRun,
    steps: [{ key: 'tickets', state: 'done' }, { key: 'review', state: 'done' }, { key: 'accept', state: 'asking' }],
    handback: { step: 'accept', choices: ['finish', 'repair', 'escalate'], question: 'Ready to accept?' },
    held: { reason: 'Waiting for owner acceptance', at: new Date(ago(1)).toISOString() },
    reason: 'Waiting for owner acceptance',
    metro: {
      ...baseRun.metro,
      stations: baseRun.metro.stations.map((s) => s.id === 'accept' ? { ...s, state: 'asking' } : { ...s, state: 'done' }),
    },
  };
  const acceptActiveView = { ...view, runs: [acceptRun] };
  const activeAcceptPlain = withMode({ lang: 'en', theme: 'terminal', icons: 'unicode' }, () =>
    renderMonitor({ state: acceptState, width: 62, height: 24, nowMs: NOW, execution: acceptActiveView, projectName: 'demo' }))
    .lines.map(stripAnsi).join('\n');
  assert.match(activeAcceptPlain, /Ready to accept\?/);
  assert.match(activeAcceptPlain, /finish · repair · escalate/);
  assert.match(activeAcceptPlain, /Waiting for owner acceptance/);
});

test('pool without recorded counts renders unknown instead of a fabricated zero count', () => {
  const unknownPoolFlow = {
    flow: 'pool-unknown', kind: 'graph', name: 'batch-step', state: 'running', createdAt: ago(4),
    stations: [
      { id: 'prep', kind: 'worker', state: 'done', title: 'Prepare' },
      { id: 'pool', kind: 'pool', state: 'waiting', deps: ['prep'], title: 'Batch step' },
      { id: 'done', kind: 'summary', state: 'waiting', deps: ['pool'], title: 'Summary' },
    ],
  };
  const emptyCountsFlow = {
    ...unknownPoolFlow,
    flow: 'pool-empty',
    stations: unknownPoolFlow.stations.map((s) => s.id === 'pool' ? { ...s, counts: {} } : s),
  };

  for (const flow of [unknownPoolFlow, emptyCountsFlow]) {
    const term = plain(paintFlow(flow, 'pool', 62, { lang: 'en', theme: 'terminal', icons: 'unicode' })).join('\n');
    assert.ok(term.includes('▐◌▌'), `terminal unknown pool should render ▐◌▌:\n${term}`);
    assert.ok(!term.includes('×0'), `must not render fabricated ×0:\n${term}`);

    const none = plain(paintFlow(flow, 'pool', 62, { lang: 'en', theme: 'none', icons: 'unicode' })).join('\n');
    assert.ok(none.includes('(◌)'), `none unknown pool should render (◌):\n${none}`);
    assert.ok(!none.includes('○×0'), `must not render (○×0):\n${none}`);

    const asc = plain(paintFlow(flow, 'pool', 62, { lang: 'en', theme: 'none', icons: 'text' })).join('\n');
    assert.ok(asc.includes('(u)'), `ASCII unknown pool should render (u):\n${asc}`);
    assert.ok(!asc.includes('o0'), `must not render (o0):\n${asc}`);

    const legend = withMode({ lang: 'en', theme: 'none', icons: 'unicode' }, () =>
      renderMetroLegend([flow], 62).map((r) => stripAnsi(r.text)).join('\n'));
    assert.ok(legend.includes('◌ unknown'), `contextual legend explains unknown glyph:\n${legend}`);
  }

  // Station Detail on a pool without counts/count also prints no fabricated zero ("Pool of 0").
  const runView = {
    root: '/synthetic/proj', complete: true, screens: new Map(), endedJobs: [], jobs: [],
    runs: [{
      flow: 'gpool000000000001', kind: 'graph', label: 'batch-step', unattended: false, state: 'working',
      createdAt: ago(4), updatedAt: ago(1),
      steps: [], tickets: [], todo: [], decisions: [], reviews: [], heldCount: 0, repairRounds: 0,
      metro: {
        stations: [
          { id: 'pool', kind: 'pool', state: 'waiting' },
        ],
        edges: [],
      },
    }],
  };
  const detailText = withMode({ lang: 'en', theme: 'terminal', icons: 'unicode' }, () =>
    renderMonitor({
      state: { ...initialMonitorState(), activeTab: 'execution', subpage: { kind: 'station-detail', flow: 'gpool000000000001', stationId: 'pool', scroll: 0 } },
      width: 62, height: 24, nowMs: NOW, execution: runView, projectName: 'demo',
    })).lines.map(stripAnsi).join('\n');
  assert.doesNotMatch(detailText, /Pool of 0/, 'pool without count must not print Pool of 0');
  assert.doesNotMatch(detailText, /0○|×0/, 'pool without counts must not print zero counts');
});
