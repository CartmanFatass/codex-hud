/** Hairline metro-map golden frames (40/62/80 cols, EN/ZH, colour/no-colour/ASCII), keyboard/mouse navigation, and ? help legend. Synthetic data only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  layoutMetroFlow,
  metroStationItem,
  renderMetroFlow,
  renderMetroLegend,
  runItem,
} from '../../dist/render/execution-metro.js';
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
      },
    ],
  };

  const decoder = new WorkbenchInputDecoder('workboard');
  const draw = (state) => withMode({ lang: 'en', theme: 'none', icons: 'unicode' }, () =>
    renderMonitor({ state, width: 62, height: 30, nowMs: NOW, execution: executionView, projectName: 'demo' }));
  const send = (state, raw) => {
    const frame = draw(state);
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
  assert.equal(state.execution.cursor, metroStationItem(flow1, 'ticket:03'));
  assert.match(draw(state).lines.map(stripAnsi).join('\n'), /◉ 03 Dead-letter view/);

  // ↓ moves across lanes: lane 0 (03) -> lane 1 (04) -> lane 2 (05) -> leaves map to flow2 header!
  state = send(state, '\x1b[B').state;
  assert.equal(state.execution.cursor, metroStationItem(flow1, 'ticket:04'));
  assert.match(draw(state).lines.map(stripAnsi).join('\n'), /\? 04 Backoff settings/);
  state = send(state, '\x1b[B').state;
  assert.equal(state.execution.cursor, metroStationItem(flow1, 'ticket:05'));
  state = send(state, '\x1b[B').state;
  assert.equal(state.execution.cursor, runItem(flow2));

  // ↑ from flow2 header re-enters flow1 on bottommost lane (05) -> 04 -> 03 -> leaves upward to flow1 header!
  state = send(state, '\x1b[A').state;
  assert.equal(state.execution.cursor, metroStationItem(flow1, 'ticket:05'));
  state = send(state, '\x1b[A').state;
  assert.equal(state.execution.cursor, metroStationItem(flow1, 'ticket:04'));
  state = send(state, '\x1b[A').state;
  assert.equal(state.execution.cursor, metroStationItem(flow1, 'ticket:03'));
  state = send(state, '\x1b[A').state;
  assert.equal(state.execution.cursor, runItem(flow1));

  // Step onto middle lane (04): ←/→ move between stations (never switch tabs, even at ends!).
  state = send(send(state, '\x1b[B').state, '\x1b[B').state;
  assert.equal(state.execution.cursor, metroStationItem(flow1, 'ticket:04'));
  state = send(state, '\x1b[D').state;
  assert.equal(state.execution.cursor, metroStationItem(flow1, 'ticket:02'));
  assert.equal(state.activeTab, 'execution');
  state = send(state, '\x1b[D').state;
  assert.equal(state.execution.cursor, metroStationItem(flow1, 'ticket:01'));
  // Left at leftmost station stays on map and does NOT switch tabs.
  state = send(state, '\x1b[D').state;
  assert.equal(state.activeTab, 'execution');
  assert.equal(state.execution.cursor, metroStationItem(flow1, 'ticket:01'));
  // Right walks 01 -> 02 -> 04 (keeps lane 1) -> 06 -> review -> accept.
  for (const id of ['ticket:02', 'ticket:04', 'ticket:06', 'review', 'accept']) {
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

  // Enter on a station WITHOUT execJob (accept) does nothing (does not open Run Detail).
  assert.equal(send(state, '\r').state.subpage, undefined);

  // Move to 04 (has execJob + live tab): g/P/H work and Enter opens Inspector; Esc returns to 04.
  state = send(send(send(state, '\x1b[D').state, '\x1b[D').state, '\x1b[D').state;
  assert.equal(state.execution.cursor, metroStationItem(flow1, 'ticket:04'));
  assert.deepEqual(send(state, 'g').action, { type: 'focus-job-tab', dir: `/synthetic/hud/jobs/${J4}` });
  const insp = send(state, '\r').state;
  assert.deepEqual([insp.subpage.kind, insp.subpage.from, insp.subpage.target.workerId],
    ['inspector', 'execution', `thin-job:${J4}`]);
  state = send(insp, '\x1b').state;
  assert.equal(state.subpage, undefined);
  assert.equal(state.execution.cursor, metroStationItem(flow1, 'ticket:04'));

  // Per-cell mouse hits: click 03 selects 03, click 05 selects 05, second click on 05 opens Inspector, empty cell is no-op.
  frame = draw(state);
  const pane = frame.panes.find((p) => p.id === 'agents');
  const findCoords = (stationId) => {
    const targetItem = metroStationItem(flow1, stationId);
    for (let i = 0; i < pane.rows.length; i++) {
      const hit = pane.rows[i].metroStations?.find((s) => s.item === targetItem);
      if (hit) return { x: pane.x + hit.x, y: pane.y + (pane.edge ?? 0) + i - pane.offset, hit };
    }
    throw new Error(`station not found: ${stationId}`);
  };
  const c3 = findCoords('ticket:03');
  const c5 = findCoords('ticket:05');
  assert.equal(monitorItemAt(pane, c3.x, c3.y), metroStationItem(flow1, 'ticket:03'));
  assert.equal(monitorItemAt(pane, c5.x, c5.y), metroStationItem(flow1, 'ticket:05'));
  assert.equal(monitorItemAt(pane, c3.x + 2, c3.y), undefined, 'line cell between stations is not a station hit');

  state = send(state, { type: 'mouse', button: 'left', x: c3.x, y: c3.y }).state;
  assert.equal(state.execution.cursor, metroStationItem(flow1, 'ticket:03'));
  // Clicking empty cell leaves cursor unchanged.
  state = send(state, { type: 'mouse', button: 'left', x: c3.x + 2, y: c3.y }).state;
  assert.equal(state.execution.cursor, metroStationItem(flow1, 'ticket:03'));
  // Click 05 selects 05; second click opens 05's Inspector.
  state = send(state, { type: 'mouse', button: 'left', x: c5.x, y: c5.y }).state;
  assert.equal(state.execution.cursor, metroStationItem(flow1, 'ticket:05'));
  assert.equal(state.subpage, undefined);
  const clickedInsp = send(state, { type: 'mouse', button: 'left', x: c5.x, y: c5.y }).state;
  assert.equal(clickedInsp.subpage.target.workerId, `thin-job:${J5}`);
});

/* ───────────────────────── 3. Layout edge cases & exec-page/04 model interface ───────────────────────── */

test('layout handles inline repair fallback, cycles, skip-a-column edges, and pre-assigned lanes cleanly', () => {
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

  // Cycle safety + skip-a-column edge + pre-assigned lanes (exec-page/04 integration surface).
  const cyclic = {
    flow: 'cyc', kind: 'graph', name: 'cyclic', state: 'running', createdAt: ago(5),
    stations: [
      { id: 'a', kind: 'worker', state: 'done', title: 'A' },
      { id: 'b', kind: 'worker', state: 'working', title: 'B' },
    ],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
  };
  assert.doesNotThrow(() => layoutMetroFlow(cyclic, 62, false));

  const preLaned = {
    flow: 'laned', kind: 'queue', name: 'pre-laned', state: 'running', createdAt: ago(15), lanes: 3,
    stations: [
      { id: 's1', num: '01', kind: 'worker', state: 'done', lane: 1, title: 'Base' },
      { id: 's2', num: '02', kind: 'worker', state: 'working', lane: 0, title: 'Top', changedAt: ago(4) },
      { id: 's3', num: '03', kind: 'worker', state: 'asking', lane: 2, title: 'Bottom', changedAt: ago(1) },
      { id: 's4', num: '04', kind: 'worker', state: 'waiting', lane: 1, title: 'Merge', waits: '02,03' },
    ],
    edges: [{ from: 's1', to: 's2' }, { from: 's1', to: 's3' }, { from: 's2', to: 's4' }, { from: 's3', to: 's4' }],
  };
  const lanedRows = paintFlow(preLaned, undefined, 62, { lang: 'en', theme: 'none' });
  assert.match(plain(lanedRows).at(-1), /\? 03 Bottom/, 'changedAt picks most recently changed station');
});
