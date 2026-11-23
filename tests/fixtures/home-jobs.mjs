/** A busy Home of 14 synthetic jobs (home-compact/02): 1 asking, 1 failed, 3 landing, 4 running, 3 queued, 2 finished. */
import { homeRows } from '../../dist/render/home-view.js';
import { initialMonitorState } from '../../dist/render/monitor.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { stripAnsi } from '../../dist/render/colors.js';
export const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const MIN = 60_000, ago = (m) => NOW - m * MIN;
const SOL = ['gpt-6.2-sol-fast', 'high'], NEON = ['gemini-4-neon-high', 'high'], SONNET = ['claude-sonnet-5-5', 'xhigh'], OPUS = ['claude-opus-5-5', 'xhigh'];
const work = (o = {}) => ({ episode: 'e', activityAt: NOW - 5000, activityBasis: 'observed', phases: [], request: false, failed: false, result: false, ...o });
let n = 0;
/** One job; `at` is the minutes since it started, or since it settled when `done`. */
function job(lane, [model, effort], o) {
  const { at = 5, done, id = `thin-job:j${String(++n).padStart(16, '0')}`, ...rest } = o;
  return { id, laneId: lane, harness: 'pi', role: 'imp', task: 'Implement the synthetic ticket in full', model, effort, state: done ? 'done' : 'working',
    startedAt: ago(at + (done ? 20 : 0)), settledAt: done ? ago(at) : null, phase: null, homeNeedsHuman: false, humanEndedAt: null, stale: false, evidence: [],
    work: work({ result: !!done, facadeClosed: !!done }), ...rest };
}
const lane = (label, workers, phase = null) => ({ id: `thin-job:package:${label}`, identity: { kind: 'invocation', home: '/synthetic/hud', root: '/synthetic/hud/jobs', jobId: 'j0' },
  label, title: label, startedAt: null, phase, workers, decisions: [], evidence: [] });
const land = (step, updated) => ({ kind: 'land', state: 'running', steps: [{ key: 'gate', state: 'active' }, { key: 'merge', state: 'pending' }], step, updatedAt: ago(updated) });
export function jobsBoard(lang = 'en') {
  n = 0;
  const T = (en, zh) => (lang === 'zh' ? zh : en);
  const L = (label) => `thin-job:package:${label}`;
  const lanes = [
    lane('cache-v2/03', [
      job(L('cache-v2/03'), SOL, { displayId: 'cache-v2/03', ticketTitle: 'Keep the fallback TTL scan', homeNeedsHuman: true, humanEndedAt: ago(4), at: 12, ask: 'Keep fallback TTL scan on startup?',
        work: work({ request: true, requestInfo: { id: 'q1', question: 'Keep fallback TTL scan on startup?', suggested: 'a) keep 60s scan', options: ['a) keep 60s scan', 'b) drop it'] } }) }),
      job(L('cache-v2/03'), ['deepseek-v4-1-flash-1017', 'high'], { id: 'thin-job:s1', role: 'sonic', parentJobId: 'thin-job:j0000000000000001' }),
    ]),
    lane('export-csv/02', [job(L('export-csv/02'), NEON, { displayId: 'export-csv/02', ticketTitle: T('Stream large CSV exports', '流式导出大型 CSV 报表'), role: 'general', state: 'failed', done: true, at: 9,
      work: work({ failed: true, result: true, reason: T('HTTP 429 rate limit; no report written', 'HTTP 429 限流；未写出报告') }) })]),
    lane('stream-sync/05', [job(L('stream-sync/05'), SOL, { displayId: 'stream-sync/05', ticketTitle: T('Drain async sockets cleanly', '异步套接字排空与关闭'), done: true, at: 2, reportUnread: true, flow: land('gate[3]: npm run test:mjs', 1) })]),
    lane('stream-sync/06', [job(L('stream-sync/06'), SONNET, { displayId: 'stream-sync/06', ticketTitle: T('Drain state badge styling', '排空状态徽章样式'), role: 'frontend-imp', done: true, at: 3, reportUnread: true, flow: land('gate[1]: npm run build', 3) })]),
    lane('auth-refresh/04', [job(L('auth-refresh/04'), NEON, { displayId: 'auth-refresh/04', ticketTitle: T('Rotate refresh window', '轮换令牌刷新时间窗口'), role: 'general', done: true, at: 4, flow: land('cherry-pick', 1) })]),
    lane('perf-ts/05', [
      job(L('perf-ts/05'), SOL, { id: 'thin-job:p1', displayId: 'perf-ts/05', ticketTitle: T('Cache the tsc project graph', '缓存 tsc 项目图'), briefTitle: T('Implement the project graph cache', '实现项目图缓存'), at: 14, work: work({ phases: ['build', 'review r1'] }) }),
      job(L('perf-ts/05'), SONNET, { displayId: 'perf-ts/05', ticketTitle: T('Cache the tsc project graph', '缓存 tsc 项目图'), briefTitle: T('Review round 1', '第 1 轮评审'), role: 'reviewer', at: 3, work: work({ phases: ['review r1'] }) }),
      job(L('perf-ts/05'), ['deepseek-v4-1-flash-1017', 'high'], { id: 'thin-job:s2', role: 'sonic', parentJobId: 'thin-job:p1' }),
    ]),
    lane('metrics-lite/01', [
      job(L('metrics-lite/01'), SOL, { id: 'thin-job:m1', displayId: 'metrics-lite/01', ticketTitle: T('Trim idle poll interval', '降低空闲轮询频率'), role: 'general', at: 6 }),
      job(L('metrics-lite/01'), ['deepseek-v4-1-flash-1017', 'high'], { id: 'thin-job:s3', role: 'sonic', parentJobId: 'thin-job:m1' }),
      job(L('metrics-lite/01'), ['deepseek-v4-1-flash-1017', 'high'], { id: 'thin-job:s4', role: 'sonic', parentJobId: 'thin-job:m1' }),
    ]),
    lane('docs-sweep/04', [job(L('docs-sweep/04'), OPUS, { displayId: 'docs-sweep/04', ticketTitle: T('Compare retry backoff options', '对比重试退避方案'), role: 'oracle', at: 21 })]),
    ...['cache-v2/04', 'export-csv/03', 'auth-refresh/05'].map((id, i) => lane(id, [job(L(id), SOL, { displayId: id, ticketTitle: 'Queued synthetic ticket', state: 'queued', queuePosition: i + 1, at: 1 })])),
    ...['cache-v1/06', 'export-csv/01'].map((id) => lane(id, [job(L(id), SOL, { displayId: id, ticketTitle: 'Finished synthetic ticket', done: true, at: 3 })])),
  ];
  return { revision: 'r', lanes, workers: lanes.flatMap((l) => l.workers), decisions: [], coverage: { incomplete: false, diagnostics: [], workspace: null } };
}
/** The job area of Home (`homeRows`, without the Waiting / Progress block below it) as plain lines. */
export function jobFrame(width, lang = 'en', board = jobsBoard(lang), state = initialMonitorState(), icons = 'unicode') {
  const display = setDisplayConfig({ theme: 'none', icons }), previous = setLanguage(lang);
  try {
    const input = { tree: { nodes: [] }, workboard: board, state, width, height: 40, nowMs: NOW };
    return homeRows(board, state, width, NOW, input).map((r) => stripAnsi(r.text));
  } finally { setDisplayConfig(display); setLanguage(previous); }
}
/** Narrow-panel rows (panel-polish/02): routed headless jobs with helpers running, a failed one, a long id, and a job with no route. */
export function narrowBoard(lang = 'en') {
  n = 0;
  const T = (en, zh) => (lang === 'zh' ? zh : en), L = (label) => `thin-job:package:${label}`;
  const route = (tier, mode) => ({ tier, mode, source: 'decision', reason: `${tier} work; ${mode} run` });
  const lanes = [
    lane('auto-route/08', [
      job(L('auto-route/08'), SOL, { id: 'thin-job:r1', displayId: 'auto-route/08', ticketTitle: T('A headless job keeps its title', '无界面任务保留标题'), at: 0, route: route('hard', 'headless'), headless: true }),
      job(L('auto-route/08'), ['deepseek-v4-1-flash-1017', 'high'], { id: 'thin-job:r2', role: 'sonic', parentJobId: 'thin-job:r1' }),
      job(L('auto-route/08'), ['deepseek-v4-1-flash-1017', 'high'], { id: 'thin-job:r3', role: 'sonic', parentJobId: 'thin-job:r1' }),
    ]),
    lane('hud-doctor/01', [job(L('hud-doctor/01'), SOL, { displayId: 'hud-doctor/01', ticketTitle: T('hud doctor shows why a job stalled', 'hud doctor 说明任务为何停滞'), done: true, at: 1, route: route('standard', 'headless'), headless: true, flow: land('gate[3]: npm run test:mjs', 1) })]),
    lane('stream-sync/05', [job(L('stream-sync/05'), SOL, { displayId: 'stream-sync/05', ticketTitle: T('Drain async sockets cleanly', '异步套接字排空与关闭'), done: true, at: 2, reportUnread: true, route: route('light', 'tab') })]),
    lane('export-csv/02', [job(L('export-csv/02'), NEON, { displayId: 'export-csv/02', ticketTitle: T('Stream large CSV exports', '流式导出大型 CSV 报表'), role: 'general', state: 'failed', done: true, at: 9, route: route('standard', 'headless'), headless: true,
      work: work({ failed: true, result: true, reason: T('HTTP 429 rate limit; no report written', 'HTTP 429 限流；未写出报告') }) })]),
    lane('statusline-workers/03', [job(L('statusline-workers/03'), SOL, { displayId: 'statusline-workers/03', ticketTitle: T('Show workers in the statusline', '在状态栏显示任务'), at: 6, route: route('hard', 'headless'), headless: true })]),
    lane('docs-sweep/04', [job(L('docs-sweep/04'), SONNET, { displayId: 'docs-sweep/04', ticketTitle: T('Compare retry backoff options', '对比重试退避方案'), role: 'general', at: 6 })]),
  ];
  return { revision: 'r', lanes, workers: lanes.flatMap((l) => l.workers), decisions: [], coverage: { incomplete: false, diagnostics: [], workspace: null } };
}
export const jobFrames = () => Object.fromEntries([
  ...[120, 80, 50].flatMap((width) => ['en', 'zh'].map((lang) => [`${lang}-${width}`, jobFrame(width, lang)])),
  ...[48, 42].flatMap((width) => ['en', 'zh'].map((lang) => [`${lang}-${width}-routes`, jobFrame(width, lang, narrowBoard(lang))])),
]);
