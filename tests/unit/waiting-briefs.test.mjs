import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WaitingBriefs } from '../../dist/collectors/waiting-briefs.js';
import { SmallModel } from '../../dist/collectors/small-model.js';
import { requestLines, questionOriginalRows } from '../../dist/render/work-card.js';
import { answerable } from '../../dist/render/job-actions.js';
import { taskHeaderRows, ticketPreview, waitingPreview } from '../../dist/render/project-view.js';
import { initialMonitorState } from '../../dist/render/monitor.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { stripAnsi } from '../../dist/render/colors.js';

const empty = { workers: [], lanes: [] };
const state = initialMonitorState(), text = rows => rows.map(r => stripAnsi(r.text)).join('\n');
const translations = { 'Choose a port?': '选择港口？', North: '北方', South: '南方', 'Approve BAY-02': '确认 BAY-02', 'Repair pier': '修复码头' };

test('panel translations: one capped batch, only open foreign prose, original folds and unchanged answer keys', async t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'harbor-locale-')), file = join(dir, 'waiting-briefs.json');
  const previous = setLanguage('zh');
  t.after(() => { setLanguage(previous); fs.rmSync(dir, { recursive: true, force: true }); });
  const sent = [], model = new SmallModel({ dir, env: { MISTRAL_API_KEY: 'synthetic-key' }, fetch: async (_, init) => {
    const fields = JSON.parse(JSON.parse(init.body).messages[1].content);
    sent.push(fields);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ translations: fields.map(s => translations[s]) }) } }] });
  } });
  model.configure({ backend: 'api', hourlyCap: 1 });
  const service = new WaitingBriefs(model, file);
  const question = { id: 'q1', question: 'Choose a port?', options: ['North', 'South'], suggested: 'North', context: '已经备妥', evidence: { relativePath: 'qa/q1.md' } };
  const worker = { id: 'thin-job:j0000000000000001', homeNeedsHuman: true, work: { requestInfo: question } };
  const board = { workers: [worker], lanes: [{ workers: [worker] }] };
  const ticket = { number: '01', title: 'Repair pier', path: '/example/01-pier.md', state: 'ready', status: 'ready-for-agent', items: [], checked: 0, total: 0, blockers: [] };
  const project = { waiting: [{ label: '', value: 'Approve BAY-02' }, { label: '', value: '检查 BAY-02' }],
    tickets: [{ slug: 'bay', tickets: [ticket, { ...ticket, state: 'done', title: 'Closed ticket' }] }] };
  service.update(board, project);
  assert.deepEqual(sent, []);
  service.configure(true, 'zh');
  service.update(empty, { waiting: [project.waiting[1]], tickets: [] });
  assert.deepEqual(sent, []);
  service.update(board, project);
  await t.waitFor(() => assert.ok(fs.existsSync(file)));
  assert.deepEqual(sent, [Object.keys(translations)]);
  assert.equal(model.usage().byFeature['waiting-brief'], 1);
  const reopened = new WaitingBriefs(model, file);
  reopened.configure(true, 'zh');
  reopened.update(board, project);
  const shown = reopened.project(project), card = { worker: reopened.board(board).workers[0] };
  const lines = (folds = []) => text(waitingPreview(shown.waiting[0], 0, 40, 0, new Set(folds)));
  assert.match(lines(), /确认 BAY-02[\s\S]*原文/);
  assert.doesNotMatch(lines(), /Approve/);
  assert.match(lines(['original:wait:0']), /Approve BAY-02/);
  assert.equal(shown.tickets[0].tickets[0].title, '修复码头');
  assert.equal(shown.tickets[0].tickets[1].originalTitle, undefined);
  assert.doesNotMatch(text(ticketPreview(shown, 'bay:01-pier.md', new Set(), 40, 0)), /Repair pier/);
  assert.match(text(ticketPreview(shown, 'bay:01-pier.md', new Set(['original:ticket:bay:01-pier.md']), 40, 0)), /原文[\s\S]*Repair pier/);
  assert.deepEqual(requestLines(card, true, true).slice(0, 4), ['选择港口？', '受阻 已经备妥', '[1] 北方', '[2] 南方']);
  assert.deepEqual(answerable(card.worker).options, ['North', 'South']);
  assert.equal(answerable(card.worker).suggested, 'North');
  const folded = questionOriginalRows(card, state, 40);
  assert.match(text(folded), /原文/);
  assert.doesNotMatch(text(folded), /Choose/);
  assert.match(text(questionOriginalRows(card, { ...state, home: { ...state.home, expanded: new Set([folded[0].item]) } }, 40)), /Choose a port\?/);
  reopened.update(empty, { waiting: [{ value: 'Release crane?' }], tickets: [] });
  await t.waitFor(() => assert.equal(model.diagnostics().lastFailure?.reason, 'hourly-cap'));
  assert.equal(sent.length, 1);
  reopened.configure(false, 'zh');
  assert.equal(reopened.project(project), project);
  assert.equal(reopened.board(board), board);
});

test('grouped task heading shows only its newest pending member’s first sentence', () => {
  const slices = [1, 2].map(at => ({ id: `BAY-0${at}`, at, state: 'try', brief: { brief: at === 1 ? '较旧。' : '最新。更多。' } }));
  const rows = taskHeaderRows({ key: 'milestone:BAY', milestone: 'BAY', slices }, {}, state, 40, 3);
  assert.match(text(rows), /BAY[\s\S]*最新。/);
  assert.doesNotMatch(text(rows), /更多|较旧/);
});
