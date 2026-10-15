import test from 'node:test';
import assert from 'node:assert/strict';
import { initialMonitorState, renderMonitor, handleMonitorInput, monitorSettings, type MonitorState } from '../../src/render/monitor.js';
import { directions, roleSet } from '../../src/render/directions.js';
import { setLanguage } from '../../src/render/i18n.js';
import { stripAnsi, visualLength, theme, colors } from '../../src/render/colors.js';
import { cardSummaryTargets, cardSentence, agentCard } from '../../src/render/cards.js';
import { defaultCardVisibility } from '../../src/card-visibility.js';
import { defaultSettings } from '../../src/settings.js';
import { SETTING_ROWS } from '../../src/render/settings-page.js';
import type { AgentLogEntry } from '../../src/collectors/agent-log.js';
import type { AgentStage, SubagentStatus, SubagentTree, SubagentTreeNode } from '../../src/types.js';

const NOW = Date.parse('2026-10-05T10:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000);
const node = (id: string, name: string, status: SubagentStatus, extra: Partial<SubagentTreeNode> = {}): SubagentTreeNode =>
  ({ id, name, status, depth: 1, children: [], startedAt: ago(60), ...extra });
const kid = (id: string, name: string, role: string | undefined, status: SubagentStatus, end?: number, extra: Partial<SubagentTreeNode> = {}): SubagentTreeNode =>
  node(id, name, status, { depth: 2, ...(role ? { role } : {}), startedAt: ago(50), ...(end !== undefined ? { statusAt: ago(end) } : {}), ...extra });
const stage = (start: number, end: number | undefined, status: AgentStage['status'], extra: Partial<AgentStage> = {}): AgentStage =>
  ({ startedAt: ago(start), ...(end !== undefined ? { endedAt: ago(end) } : {}), status, ...extra });

/** A lead at work with a helper, its subtasks in team roles; a writer finished long ago. */
function session(): SubagentTree {
  const lead = node('lead', 'parser_lead', 'running', { agentPath: '/root/parser_lead', turnStartedAt: ago(12), peers: { '/root/critic': 2 },
    stages: [stage(12, undefined, 'running', { intent: 'I will wire the streaming API through the new recovery path.' })],
    action: { name: 'exec', text: 'npm run\nbench', at: ago(1) },
    children: [
      kid('i1', 'impl_a', 'team-implementer', 'completed', 40), kid('i2', 'impl_b', 'team-implementer', 'running', undefined, { turnStartedAt: ago(3) }),
      kid('r1', 'review_a', 'team-reviewer', 'completed', 30, { stages: [stage(35, 30, 'done', { result: 'Two nits; ship it.' })] }),
      kid('s1', 'scout_a', 'team-scout', 'error', 20), kid('g1', 'general_a', 'default', 'completed', 25), kid('n1', 'plain_a', undefined, 'completed', 24),
    ] });
  const critic = node('critic', 'critic', 'running', { agentPath: '/root/critic', peers: { '/root/parser_lead': 2 }, turnStartedAt: ago(2) });
  const writer = node('writer', 'docs_writer', 'completed', { startedAt: ago(400), statusAt: ago(300) });
  return { rootId: 'root', nodes: [lead, critic, writer], totalCount: 9, updatedAt: new Date(NOW) };
}
const rich = (extra: Partial<MonitorState> = {}): MonitorState =>
  ({ ...initialMonitorState(), style: 'rich', ...extra, tree: { ...initialMonitorState().tree, showAll: true, ...extra.tree } });
const draw = (state = rich(), width = 44, tree = session(), agentLog?: Map<string, AgentLogEntry[]>) =>
  renderMonitor({ tree, state, width, height: 60, nowMs: NOW, agentLog });
const plain = (lines: string[]) => lines.map(line => stripAnsi(line).trimEnd());
/** A card's lines, its top rule to its bottom one. */
const card = (lines: string[], name: string) => {
  const top = lines.findIndex(line => /^[┌╭›] /.test(line) && line.includes(` ${name} `));
  const end = lines.findIndex((line, i) => i > top && /^[└╰]/.test(line));
  return lines.slice(top, end + 1);
};

test('only the L1 agents have cards; the summary counts them, at work while a subtask is, and their subtasks as one figure', () => {
  const lines = plain(draw().lines);
  // The title gives up its name before the counts' words.
  const summary = (lines: string[]) => lines.find(line => /^ ▦ (Agents )? \S/.test(line))!;
  assert.match(summary(lines), /▸2 run .*· 6 subtasks, 1 failed$/, 'the subtasks as one figure, with their failures');
  for (const name of ['impl_a', 'general_a', 'plain_a']) assert.ok(!lines.some(line => line.includes(name)), name);
  assert.ok(lines.some(line => line.includes('impl_b')), 'a live subtask stays on the closed card');
  assert.ok(lines.some(line => /^┌ ✓ docs_writer ─+/.test(line)), 'an old finished L1 is still a card');
  // A finished lead with a subtask still at work keeps its card, and counts as at work.
  const tree = session();
  tree.nodes[0] = { ...tree.nodes[0], status: 'completed', statusAt: ago(30), stages: [], action: undefined };
  const kept = plain(draw(rich(), 44, tree).lines);
  assert.ok(kept.some(line => /^[┌›] ✓ parser_lead/.test(line)), kept.join('\n'));
  assert.match(summary(kept), /▸2 run/);
});

test('a card: its name in its direction\'s colour, whom it works with, what it is doing, the subtasks that matter, the rest by role; not its own words cut to a line', () => {
  const tree = session();
  const frame = draw(rich(), 44, tree);
  const lines = plain(frame.lines);
  const lead = card(lines, 'parser_lead');
  assert.deepEqual(lead.slice(1, 3), [
    '│ ⇄ critic',
    '│ ▸ npm run bench',
  ], lead.join('\n'));
  assert.ok(lead.some(line=>/^│ ▸ impl_b +◷3m00s$/.test(line)),lead.join('\n'));
  assert.ok(lead.some(line=>/scout_a/.test(line)) && lead.some(line=>/implementer/.test(line)),'important failure and role counts default on');
  assert.ok(!lead.some(line=>/review_a/.test(line)),'ordinary completed child hidden');
  const paint = directions(tree).paint('lead');
  assert.ok(frame.lines.some(line => line.includes(theme.bold(paint(colors.underline('parser_lead'))))), 'bold, in its direction\'s colour, underlined to click');
  const openedLead = card(plain(draw(rich(), 44, tree).lines), 'parser_lead');
  assert.ok(openedLead.some(line => /^│ ! scout_a +20m$/.test(line)), openedLead.join('\n'));
  assert.ok(draw(rich(), 44, tree).lines.some(line => line.includes(theme.info('2'))), 'a role with an agent running: its count in the running colour');
  // The helper's card names the lead it works for, in the lead's colour.
  const critic = card(lines, 'critic');
  assert.equal(critic[1], '│ → parser_lead');
  assert.ok(frame.lines.some(line => line.includes(paint('parser_lead')) && stripAnsi(line).includes('→')));
  // Wider, every role fits; the shared "team-" is left out, Codex's default and a missing role are "general".
  const wide = card(plain(draw(rich(), 60, tree).lines), 'parser_lead');
  assert.equal(wide.at(-2), '│ 2 general · 2 implementer · 1 reviewer · 1 scout', 'the most first, a tie by name');
});

test('the subtasks that matter: failed, a named role (or its end), or flagged; three closed, all opened; a click selects one', () => {
  const tree = session();
  const named = rich({ importantRoles: roleSet('reviewer') });
  const openedState = named;
  const lines = plain(draw(openedState, 52, tree).lines);
  const lead = card(lines, 'parser_lead');
  assert.ok(lead.some(line => /^│ ✓ review_a +30m$/.test(line)), 'its own answer is the Inspector\'s: ' + lead.join('\n'));
  // The model's digest of it is the model's words, on the opened card.
  const digested = session();
  digested.nodes[0].children = digested.nodes[0].children.map(kid => kid.id === 'r1' ? { ...kid, digest: 'ship it' } : kid);
  assert.ok(card(plain(draw(openedState, 52, digested).lines), 'parser_lead').some(line => /^│ ✓ review_a ship it +30m$/.test(line)));
  // Closed, only the live subtask. Opened, every one that matters.
  const log = new Map<string, AgentLogEntry[]>(['i1', 'i2', 'g1', 'n1'].map(id => [id, [{ at: NOW - 60_000, kind: 'note', text: 'look', attention: true }]]));
  const closed = card(plain(draw(named, 52, tree, log).lines), 'parser_lead');
  const kids = (lines: string[]) => lines.filter(line => /^│ [!✓▸] (impl|review|scout|general|plain)_/.test(line)).length;
  assert.equal(kids(closed), 6, closed.join('\n'));
  assert.ok(closed.some(line => line.includes('impl_b')));
  assert.ok(closed.some(line=>line.includes('review_a')) && closed.some(line=>line.includes('scout_a')));
  const opened = card(plain(draw(named, 52, tree, log).lines), 'parser_lead');
  assert.equal(kids(opened), 6, opened.join('\n'));
  assert.match(opened.find(line => /scout_a/.test(line)) ?? '', /! scout_a/, 'failures first');
  // A click on a subtask's line selects it, for the Inspector; the line marks it.
  const frame = draw(openedState, 52, tree);
  const y = frame.lines.findIndex(line => stripAnsi(line).includes('scout_a'));
  const picked = handleMonitorInput(frame.state, { type: 'mouse', button: 'left', x: 4, y }, { tree, frame, nowMs: NOW }).state;
  assert.equal(picked.tree.selectedId, 's1');
  assert.ok(plain(draw(picked, 52, tree).lines).some(line => line.startsWith('│ ›! scout_a')));
});

test('a subtask\'s digest or cause wraps under its name, whole; with too little room beside the name it starts on the next line', () => {
  const cause = 'The harness timed out on the large corpus after the cache warmed up';
  const tree = session();
  tree.nodes[0].children = tree.nodes[0].children.map(kid => kid.id === 's1' ? { ...kid, name: 'scout_streams_long_name' } : kid);
  const log = new Map<string, AgentLogEntry[]>([['s1', [{ at: NOW - 60_000, kind: 'cause', text: cause }]]]);
  const said = (width: number) => {
    const frame = draw(rich(), width, tree, log);
    const lead = card(plain(frame.lines), 'parser_lead');
    const at = lead.findIndex(line => line.includes('scout_streams'));
    const lines = [lead[at], ...lead.slice(at + 1).filter((line, i, all) => all.slice(0, i + 1).every(l => /^│ {3}\S/.test(l)))];
    return { frame, lines };
  };
  for (const width of [32, 44, 56]) {
    const { lines } = said(width);
    assert.ok(!lines.some(line => line.includes('…')), lines.join('\n'));
    assert.match(lines[0], /20m$/, 'its time stays at the right of its first line');
    const words = lines.map(line => line.replace(/^│ (! scout_\S*)?/, '').replace(/20m$/, '').trim()).join(' ').trim();
    assert.equal(words, cause, `${width}: ${lines.join('\n')}`);
  }
  // Narrow, the name leaves no room beside it: the words start under it.
  assert.match(said(32).lines[0], /^│ ! scout_streams_long_name +20m$/);
  // A click on a wrapped line selects the subtask too.
  const { frame } = said(44);
  const y = frame.lines.findIndex(line => stripAnsi(line).startsWith('│   ') && stripAnsi(line).includes('corpus'));
  assert.equal(handleMonitorInput(frame.state, { type: 'mouse', button: 'left', x: 6, y }, { tree, frame, nowMs: NOW }).state.tree.selectedId, 's1');
});

test('the role counts can be left out, and the corners can be round', () => {
  const lines = plain(draw(rich({ cardVisibility:{cardRoleCounts:false}, cardCorners: 'round', tree: { ...initialMonitorState().tree, selectedId: 'writer' } })).lines);
  const lead = card(lines, 'parser_lead');
  assert.match(lead[0], /^╭ ▸ parser_lead/);
  assert.match(lead.at(-1)!, /^╰ ◷12m00s/);
  assert.ok(!lead.some(line => /implementer/.test(line)));
  const settings = monitorSettings({ ...defaultSettings(), cardCorners: 'round', cardRoleCounts: false });
  assert.deepEqual([settings.cardCorners, settings.cardVisibility?.cardRoleCounts], ['round', false]);
  assert.deepEqual([defaultSettings().cardCorners, defaultSettings().cardRoleCounts], ['square', true]);
  assert.deepEqual(SETTING_ROWS.filter(row => row.key === 'cardCorners' || row.key === 'cardRoleCounts').map(row => [row.group, row.values]),
    [['Cards', ['square', 'round']], ['Cards', [true, false]]]);
});

test('j and k step from card to card, never onto a subtask; from one selected on its lead\'s card, up is the lead', () => {
  const tree = session();
  // Running first, the newest turn first: the critic, the lead, then the writer.
  const frame = draw(rich({ tree: { ...initialMonitorState().tree, selectedId: 'critic' } }), 44, tree);
  let state = frame.state;
  const seen: string[] = [];
  for (let i = 0; i < 3; i++) { state = handleMonitorInput(state, { type: 'key', key: 'down' }, { tree, frame, nowMs: NOW }).state; seen.push(state.tree.selectedId!); }
  assert.deepEqual(seen, ['lead', 'writer', 'writer']);
  const inside = { ...frame.state, tree: { ...frame.state.tree, selectedId: 's1' } };
  assert.equal(handleMonitorInput(inside, { type: 'key', key: 'up' }, { tree, frame, nowMs: NOW }).state.tree.selectedId, 'lead');
  assert.equal(handleMonitorInput(inside, { type: 'key', key: 'down' }, { tree, frame, nowMs: NOW }).state.tree.selectedId, 'writer');
  // The help names no folding in the cards: there is nothing under a card to fold.
  const help = plain(draw(rich({ help: true }), 70).lines).join('\n');
  assert.ok(!help.includes('fold / unfold agent'));
  assert.ok(plain(draw({ ...initialMonitorState(), help: true }, 70).lines).join('\n').includes('fold / unfold agent'), 'the compact tree still folds');
});

test('a card counts as every view does: its subtasks at any depth, and its reviews apart, on its ◈, red when one failed', () => {
  const review = (id: string, status: SubagentStatus) =>
    node(id, 'guardian', status, { depth: 2, kind: 'guardian', startedAt: ago(320), statusAt: ago(310) });
  // The writer, long finished: a subtask whose own subtask failed, and a review that failed.
  const tree = session();
  tree.nodes[2] = { ...tree.nodes[2], children: [
    kid('w1', 'w1', 'team-implementer', 'completed', 310, { children: [node('w1x', 'w1_probe', 'error', { depth: 3, startedAt: ago(315), statusAt: ago(312) })] }),
    review('wg', 'error'),
  ] };
  const lines = draw(rich(), 44, tree).lines;
  const row = lines.find(line => stripAnsi(line).includes('docs_writer'))!;
  assert.match(stripAnsi(row).trimEnd(), /^┌ ✓ docs_writer .*◈1$/);
  assert.ok(plain(lines).some(line=>line.includes('w1_probe')),'failure at depth three is named');
  assert.ok(row.includes(theme.error('◈1')), 'the ◈ in red: a review failed');
  assert.match(plain(lines).find(line => /^ ▦ /.test(line))!, /· 8 subtasks, 2 failed$/, 'as the title counts them');
  // A lead at work names a failure two levels down on its card, and a review under a subtask that failed.
  const deep = session();
  const [lead] = deep.nodes;
  deep.nodes[0] = { ...lead, children: [...lead.children.slice(0, 2), kid('i3', 'impl_c', 'team-implementer', 'completed', 10, { children: [
    node('i3x', 'deep_probe', 'error', { depth: 3, startedAt: ago(9), statusAt: ago(8) }),
    { ...review('i3g', 'error'), depth: 3 },
  ] })] };
  const drawn = card(plain(draw(rich(), 44, deep).lines), 'parser_lead');
  assert.match(drawn[0], / ◈1( |$)/, drawn.join('\n'));
  assert.ok(drawn.some(line => line.includes('deep_probe')), drawn.join('\n'));
  assert.ok(drawn.some(line => /! guardian/.test(line)), drawn.join('\n'));
});

test('a finished L1\'s row counts its subtasks by state, and cards keep to the width in both languages', () => {
  const tree = session();
  tree.nodes[2] = { ...tree.nodes[2], children: [kid('w1', 'w1', 'team-implementer', 'completed', 310), kid('w2', 'w2', 'team-scout', 'error', 305)] };
  const lines = plain(draw(rich(), 44, tree).lines);
  assert.match(lines.find(line => line.includes('docs_writer'))!, /^┌ ✓ docs_writer ─+$/);
  assert.ok(lines.some(line=>/^│ ! w2/.test(line)));
  for (const language of ['en', 'zh'] as const) {
    const previous = setLanguage(language);
    try {
      for (const width of [16, 24, 32, 40, 48, 56]) {
        const frame = draw(rich({ importantRoles: roleSet('reviewer') }), width, tree);
        for (const line of frame.lines) assert.ok(visualLength(line) <= width, `${language} ${width}: ${stripAnsi(line)}`);
        for (const c of frame.controls) assert.ok(c.x >= 0 && c.x + c.width <= width, `${language} ${width}: control ${c.kind}`);
      }
    } finally { setLanguage(previous); }
  }
});

test('newest model note stays whole opened; live kid progress beats stale digest, request state preserves both notes', () => {
  const previous = setLanguage('en');
  try {
    const leadNote = 'Latest model note describes the streaming parser recovery work and ends with LEAD_END';
    const kidNote = 'Active child progress is validating long cache recovery scenarios and ends with CHILD_END';
    const child = kid('child', 'child', undefined, 'running', undefined, {digest: 'STALE_DIGEST'});
    const lead = node('lead', 'lead', 'running', {children: [child], task: 'RAW_TASK'});
    const tree: SubagentTree = {rootId: 'root', nodes: [lead], totalCount: 2, updatedAt: new Date(NOW)};
    const log = new Map<string, AgentLogEntry[]>([
      ['lead', [{at: NOW-2000, kind: 'note', text: 'OLD_HISTORY'}, {at: NOW-1000, kind: 'report', text: 'RAW_REPORT'}, {at: NOW, kind: 'note', text: leadNote}]],
      ['child', [{at: NOW, kind: 'note', text: kidNote}]],
    ]);
    for (const width of [32,40,48,56]) {
      const render = (open: boolean, progress?: Map<string, {running: boolean; error?: string}>) => renderMonitor({tree, state: rich(), width, height: 80, nowMs: NOW, agentLog: log, progress});
      const closed = plain(render(false).lines);
      assert.equal(closed.filter(line => line.startsWith('│ Latest')).length, 1);
      assert.ok(closed.some(line => line.includes('LEAD_END')),'the L1 summary always wraps whole');
      for (const request of [undefined, {running:true}, {running:false,error:'synthetic timeout'}]) {
        const progress = request ? new Map([['lead',request],['child',request]]) : undefined;
        const frame = render(true,progress);
        const text = plain(frame.lines).join('\n');
        assert.ok(text.includes('LEAD_END') && text.includes('CHILD_END'), text);
        assert.ok(!/STALE_DIGEST|RAW_TASK|RAW_REPORT|OLD_HISTORY/.test(text));
        if (request) assert.ok(text.includes(request.running ? 'Writing progress' : 'Progress summary'), text);
        for (const line of frame.lines) assert.equal(visualLength(line), width);
        for (const control of frame.controls) assert.ok(control.x >= 0 && control.x+control.width <= width);
      }
    }
  } finally {setLanguage(previous);}
});

const cardInput = (tree: SubagentTree, state: MonitorState, agentLog?: Map<string,AgentLogEntry[]>) =>
  ({tree,state,width:56,height:100,nowMs:NOW,agentLog});

function visibilityScene() {
  const children = [
    kid('live','live_child','team-worker','running',undefined,{digest:'STALE_RESULT',label:'smart_live'}),
    kid('failed','failed_child','team-worker','error',2,{digest:'STALE_FAILURE'}),
    kid('done','done_child','team-worker','completed',3,{digest:'Digest wins. Other detail\nBasis: synthetic evidence'}),
    kid('key','key_child','team-reviewer','completed',4),
    kid('flag','flag_child','team-worker','completed',5),
    kid('reviewLive','review_live','team-review','running',undefined,{kind:'guardian'}),
    kid('reviewFailed','review_failed','team-review','error',6,{kind:'guardian'}),
    kid('reviewKey','review_key','team-reviewer','completed',7,{kind:'guardian'}),
    kid('reviewDone','review_done','team-review','completed',8,{kind:'guardian'}),
  ];
  const lead = node('lead','original_lead','running',{label:'SmartLead',task:'RAW_TASK',taskKind:'fix',children,
    agentPath:'/root/lead',peers:{'/root/helper':4},turnStartedAt:ago(1),lastEventAt:ago(0),
    action:{name:'exec',text:'synthetic-command',at:ago(0)},model:'gpt-6.1-sol',effort:'high',
    outputRate:{tokensPerSecond:42,sampleMs:1000,sampledAt:ago(0)},
    contextUsage:{percent:67,used:67,total:100,inputTokens:0,outputTokens:0,cachedTokens:0,compactCount:0}});
  const helper = node('helper','relation_helper','running',{agentPath:'/root/helper',peers:{'/root/lead':1}});
  const tree: SubagentTree = {rootId:'root',nodes:[lead,helper],totalCount:11,updatedAt:new Date(NOW)};
  const log = new Map<string,AgentLogEntry[]>([
    ['lead',[{at:NOW-1000,kind:'note',text:'OLD_HISTORY'},{at:NOW,kind:'report',text:'RAW_REPORT'},
      {at:NOW,kind:'note',text:'The newest lead summary wraps in full and ends with LEAD_END. Another lead sentence stays.'}]],
    ['live',[{at:NOW,kind:'note',text:'Live progress wins. SECOND_SENTENCE'}]],
    ['failed',[{at:NOW,kind:'note',text:'Fallback note'},{at:NOW,kind:'cause',text:'Cause wins. SECOND_CAUSE'}]],
    ['done',[{at:NOW,kind:'note',text:'Do not prefer this note'}]],
    ['flag',[{at:NOW,kind:'note',text:'Flagged progress',attention:true}]],
  ]);
  return {lead,tree,log};
}

test('every card flag composes independently, with identity/status retained even when all optional fields are off', () => {
  const {lead,tree,log} = visibilityScene();
  const v = defaultCardVisibility();
  const drawCard = (flags: Partial<typeof v>, width=56) => {
    const state = rich({labelAsName:true,importantRoles:roleSet('reviewer'),cardVisibility:flags});
    return agentCard({node:lead,depth:0,prefix:'',hasChildren:true,collapsed:false,context:false,parentId:null},cardInput(tree,state,log),state,width,NOW);
  };
  const words = (flags: Partial<typeof v>) => plain(drawCard(flags).map(row=>row.text)).join('\n');
  const full = words({cardOriginalName:true});
  for (const token of ['SmartLead','name original_lead','LEAD_END','Another lead sentence','relation_helper','synthetic-command','smart_live','Cause wins','6.1sol','◈4','◷1m00s','~42 tok/s','67%','worker']) assert.ok(full.includes(token),token+'\n'+full);
  const tests: Array<[keyof typeof v,string]> = [
    ['cardLabel','SmartLead'],['cardOriginalName','name original_lead'],['cardSummary','LEAD_END'],
    ['cardRelations','relation_helper'],['cardAction','synthetic-command'],['cardSubagents','smart_live'],
    ['cardSubagentSummary','Cause wins'],['cardRoleCounts','worker'],['cardModel','6.1sol'],
    ['cardReviews','◈4'],['cardClock','◷1m00s'],['cardRate','~42 tok/s'],['cardContext','67%'],
  ];
  for (const [flag,token] of tests) {
    const text = words({cardOriginalName:true,[flag]:false});
    assert.ok(!text.includes(token),`${flag}: ${text}`);
    assert.ok(text.includes(flag==='cardLabel' ? 'original_lead' : 'SmartLead'));
    assert.ok(!/RAW_TASK|RAW_REPORT|OLD_HISTORY|STALE_RESULT|SECOND_SENTENCE|SECOND_CAUSE/.test(text));
    if (flag==='cardSubagentSummary') assert.ok(text.includes('smart_live') && text.includes('failed_child'));
    if (flag==='cardReviews') assert.ok(text.includes('review_live'),'review chip visibility is independent from descendant list');
    if (flag==='cardSubagents') assert.ok(text.includes('worker'),'role count is independent from child list');
  }
  const off = Object.fromEntries(Object.keys(v).filter(key=>key!=='cardSubagentScope').map(key=>[key,false])) as Partial<typeof v>;
  for (const width of [16,24,32,40,48,56]) {
    const rows = drawCard(off,width);
    assert.equal(rows.length,2);
    assert.match(stripAnsi(rows[0].text),/^┌ ▸ /);
    assert.ok(stripAnsi(rows[0].text).includes(width < 24 ? 'origin…ead' : 'original_lead'));
    assert.match(stripAnsi(rows[1].text),/^└ ─+$/);
    assert.ok(rows.every(row=>visualLength(row.text)<=width));
    assert.ok(rows.flatMap(row=>row.controls??[]).every(c=>c.kind==='log'||c.kind==='switch'));
  }
});

test('clock, rate and context are separate footer fields in all eight combinations, and child clocks follow clock', () => {
  const {lead,tree,log} = visibilityScene();
  for (const cardClock of [false,true]) for (const cardRate of [false,true]) for (const cardContext of [false,true]) {
    const state = rich({cardVisibility:{cardClock,cardRate,cardContext}});
    const rows = agentCard({node:lead,depth:0,prefix:'',hasChildren:true,collapsed:false,context:false,parentId:null},cardInput(tree,state,log),state,56,NOW);
    const foot = stripAnsi(rows.at(-1)!.text);
    assert.equal(foot.includes('◷1m00s'),cardClock,foot);
    assert.equal(foot.includes('~42 tok/s'),cardRate,foot);
    assert.equal(foot.includes('67%'),cardContext,foot);
    const failed = rows.find(row=>stripAnsi(row.text).includes('failed_child'))!;
    assert.equal(stripAnsi(failed.text).includes('2m'),cardClock);
  }
});

test('child scope and summary toggles use identical subjects for rendering and progress eligibility, including reviews', () => {
  const {tree,log} = visibilityScene();
  const expected = {
    live:['live','reviewLive'],
    important:['live','failed','key','flag','reviewLive','reviewFailed','reviewKey'],
    all:['live','failed','done','key','flag','reviewLive','reviewFailed','reviewKey','reviewDone'],
  };
  for (const cardSubagentScope of ['live','important','all'] as const)
    for (const cardSubagents of [false,true]) for (const cardSubagentSummary of [false,true]) for (const cardSummary of [false,true]) {
      const state = rich({importantRoles:roleSet('reviewer'),cardVisibility:{cardSubagentScope,cardSubagents,cardSubagentSummary,cardSummary}});
      const frame = renderMonitor({...cardInput(tree,state,log),height:120});
      const targets = cardSummaryTargets({tree,agentLog:log},state,NOW);
      assert.deepEqual([...targets].sort(),[...(cardSummary?['lead','helper']:[]),...(cardSubagents&&cardSubagentSummary?expected[cardSubagentScope]:[])].sort());
      const shown = new Set(frame.controls.filter(c=>c.kind==='log').map(c=>c.item));
      for (const id of expected.all) assert.equal(shown.has(id),cardSubagents && (expected[cardSubagentScope] as string[]).includes(id),id);
      const text = plain(frame.lines).join('\n');
      assert.equal(text.includes('Live progress wins.'),cardSubagents&&cardSubagentSummary);
      assert.equal(text.includes('LEAD_END'),cardSummary);
      assert.ok(!/SECOND_SENTENCE|SECOND_CAUSE|STALE_RESULT|STALE_FAILURE/.test(text));
    }
});

test('hidden summaries have no pending/error rows or targets; linger/filter, tabs, zoom and help gate UI eligibility', () => {
  const {tree,log} = visibilityScene();
  const progress = new Map(tree.nodes.flatMap(n=>[n,...n.children]).map(n=>[n.id,{running:false,error:'synthetic error'}]));
  for (const cardSummary of [false,true]) for (const cardSubagentSummary of [false,true]) {
    const state = rich({cardVisibility:{cardSummary,cardSubagentSummary}});
    const text = plain(renderMonitor({...cardInput(tree,state,log),height:120,progress}).lines).join('\n');
    assert.equal(text.includes('Progress summary failed'),cardSummary||cardSubagentSummary);
    if (!cardSummary&&!cardSubagentSummary) assert.equal(cardSummaryTargets({tree,agentLog:log},state,NOW).size,0);
  }
  const hidden: Partial<MonitorState>[] = [{style:'compact'},{help:true},{modes:{...rich().modes,agents:'closed'}},
    {tabbed:true,focus:'details'},{zoom:true,focus:'timeline'}];
  for (const extra of hidden) assert.equal(cardSummaryTargets({tree,agentLog:log},rich(extra),NOW).size,0);
  const old = node('old','old','completed',{statusAt:ago(20)});
  const failed = node('error','failed','error',{statusAt:ago(20)});
  const live = node('new','live','running');
  const subjects: SubagentTree = {...tree,nodes:[old,failed,live]};
  const state = rich({tree:{...rich().tree,showAll:false,lingerMs:60_000}});
  assert.deepEqual([...cardSummaryTargets({tree:subjects},state,NOW)].sort(),['error','new']);
  assert.deepEqual([...cardSummaryTargets({tree:subjects},{...state,tree:{...state.tree,showAll:true}},NOW)].sort(),['error','new','old']);
  assert.deepEqual([...cardSummaryTargets({tree:subjects},{...state,tree:{...state.tree,filter:'failed'}},NOW)],['error']);
});

test('child sentence extraction keeps only meaningful model prose with a 160-codepoint safety bound', () => {
  assert.equal(cardSentence('\n- The result landed. More details.\nBasis: synthetic'), 'The result landed.');
  assert.equal(cardSentence('Basis: synthetic evidence\nCaveats: irrelevant\nSummary: First meaningful result! Second result.'),'First meaningful result!');
  assert.equal(cardSentence('修复已完成。更多内容\n依据：测试'), '修复已完成。');
  assert.equal(cardSentence('Version 6.1 works. More detail.'),'Version 6.1 works.');
  // A digest is one line, its conclusion and evidence joined by " · " (digestText):
  // the basis and caveats stay in the Inspector, with or without terminal punctuation.
  assert.equal(cardSentence('Fixed the timeout by warming the cache · Basis: synthetic slow disk · Caveats: untested on CI'),
    'Fixed the timeout by warming the cache');
  assert.equal(cardSentence('Compared input · output before merging · Basis: synthetic'),
    'Compared input · output before merging');
  assert.equal(cardSentence('完成对比 · 依据：合成数据 · 注意事项：未部署'), '完成对比');
  assert.equal(cardSentence('存疑：合成风险。依据：测试数据'), '存疑：合成风险。');
  assert.equal([...cardSentence('界'.repeat(200))].length,160);
  assert.ok(cardSentence('界'.repeat(200)).endsWith('…'));
  assert.equal(cardSentence('Caveats: none\nBasis: none'),'');
  assert.equal(cardSentence('Escaped\x1b[2J. More.'),'Escaped\\x1b[2J.');
});

test('child sentences wrap whole at every panel width, sanitize once, and never use active stale digests', () => {
  const text = '模型正在核对缓存恢复并准备提交完整的测试结果给协调者。忽略第二句话';
  const child = kid('child','child_with_a_long_name','worker','running',undefined,{digest:'STALE_DIGEST',task:'RAW_TASK'});
  const done = kid('done','done','worker','completed',2,{digest:'Basis: synthetic\n- Digest result wraps completely beside or under its name. Ignore later.\nCaveats: none'});
  const failed = kid('failed','failed','worker','error',3,{digest:'STALE_FAILURE'});
  const lead = node('lead','lead','running',{children:[child,done,failed]});
  const tree: SubagentTree = {rootId:'root',nodes:[lead],totalCount:4,updatedAt:new Date(NOW)};
  const agentLog = new Map<string,AgentLogEntry[]>([
    ['child',[{at:NOW,kind:'note',text}]],
    ['failed',[{at:NOW,kind:'note',text:'Fallback note only. Ignore later.'}]],
  ]);
  for (const lang of ['en','zh'] as const) {
    const previous = setLanguage(lang);
    try {
      for (const width of [16,24,32,40,48,56]) {
        const state = rich({cardVisibility:{cardClock:false,cardSubagentScope:'all',cardRoleCounts:false}});
        const frame = renderMonitor({tree,state,agentLog,width,height:100,nowMs:NOW});
        const childRows = (id: string) => frame.panes[0].rows.filter(row=>row.controls?.some(c=>c.kind==='log'&&c.item===id)).map(row=>stripAnsi(row.text).slice(2).trim());
        const childWords = childRows('child').slice(1).join('').replace(/\s/g,'');
        // The long name leaves no beside room at narrow widths; wider, take the sentence after the name.
        const all = childRows('child').join('').replace(/\s/g,'');
        assert.ok(all.includes('模型正在核对缓存恢复并准备提交完整的测试结果给协调者。'),all);
        const full = plain(frame.lines).join('\n');
        assert.ok(!/忽略第二句话|STALE_DIGEST|STALE_FAILURE|RAW_TASK|Basis|Caveats|Ignore later/.test(full),full);
        const doneText = childRows('done').join(' ');
        assert.ok(doneText.includes('Digest result') || doneText.includes('Digest'),doneText);
        assert.ok(childRows('failed').join(' ').includes('Fallback note'),full);
        for (const line of frame.lines) assert.equal(visualLength(line),width);
        for (const control of frame.controls) assert.ok(control.x>=0 && control.x+control.width<=width);
      }
    } finally {setLanguage(previous);}
  }
  const raw = 'Safe\x1b[2J. Not shown.';
  assert.equal(cardSentence(raw),'Safe\\x1b[2J.');
});
