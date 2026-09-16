import test from 'node:test';
import assert from 'node:assert/strict';
import { navigateSession, type NavigationAdapter, type NavigationPane } from '../../src/utils/session-navigation.js';

const root = '00000000-0000-0000-0000-000000000001';
const child = '00000000-0000-0000-0000-000000000002';
const absent = '00000000-0000-0000-0000-000000000099';
const placeholder = '\x1b[1m›\x1b[0m \x1b[2mAsk a question\x1b[0m';

class FakePane implements NavigationAdapter {
  current = root;
  selected = 0;
  picker = false;
  draft = '';
  targetDraft = '';
  command = 'codex';
  inMode = false;
  refuseSwitch = false;
  focused = false;
  sent: string[] = [];
  ids = [root, child];
  async readPane(): Promise<NavigationPane> {
    const capture = this.picker ? ['  Subagents', '  Select an agent to watch. ← previous, → next.', '',
      ...this.ids.map((id, i) => `${this.selected === i ? '›' : ' '} ${i+1}. ${i ? 'worker' : 'Main [default]'}${this.current === id ? ' (current)' : ''}  ${id}`),
      '', '  Press enter to confirm or esc to go back'].join('\n')
      : `Transcript\n${this.draft ? `\x1b[1m›\x1b[0m ${this.draft}` : placeholder}\n\n  ? for shortcuts`;
    return { capture, cursorX: 2 + this.draft.length, cursorY: 1, command: this.command, inMode: this.inMode };
  }
  async sendKeys(_pane: string, keys: string[], literal = false): Promise<void> {
    this.sent.push(...keys);
    if (literal) { this.draft += keys.join(''); return; }
    for (const key of keys) {
      if (key === 'Enter' && this.picker) {
        if (!this.refuseSwitch) this.current = this.ids[this.selected];
        this.picker = false;
        this.draft = this.current === child ? this.targetDraft : '';
      } else if (key === 'Enter' && this.draft === '/subagents') {
        this.picker = true; this.draft = ''; this.selected = this.ids.indexOf(this.current);
      } else if (key === 'Escape' && this.picker) this.picker = false;
      else if (key === 'Home' && this.picker) this.selected = 0;
      else if (key === 'Down' && this.picker) this.selected = Math.min(this.ids.length - 1, this.selected + 1);
      else if (key === 'Up' && this.picker) this.selected = Math.max(0, this.selected - 1);
    }
  }
  async focusPane(): Promise<void> { this.focused = true; }
  async wait(_ms: number): Promise<void> {}
}

test('switches exact agent UUID and returns to main through the verified picker', async () => {
  const pane = new FakePane();
  assert.equal((await navigateSession('%1', child, pane)).ok, true);
  assert.equal(pane.current, child);
  assert.equal(pane.picker, false);
  assert.equal(pane.focused, true);
  assert.equal((await navigateSession('%1', root, pane)).ok, true);
  assert.equal(pane.current, root);
  assert.ok(!pane.sent.some(key => ['C-c', 'C-u', 'C-k'].includes(key)));
});

test('preserves existing drafts and refuses unknown panes or copy mode', async () => {
  for (const kind of ['draft', 'shell', 'copy'] as const) {
    const pane = new FakePane();
    if (kind === 'draft') pane.draft = 'keep this unsent';
    if (kind === 'shell') pane.command = 'zsh';
    if (kind === 'copy') pane.inMode = true;
    const result = await navigateSession('%1', child, pane);
    assert.equal(result.ok, false);
    assert.equal(pane.sent.length, 0);
    if (kind === 'draft') { assert.match(result.message, /draft|composer/i); assert.equal(pane.draft, 'keep this unsent'); }
  }
});

test('does not confuse a draft at cursor start with the dim empty placeholder', async () => {
  const pane = new FakePane();
  pane.draft = 'Ask a question';
  const read = pane.readPane.bind(pane);
  pane.readPane = async () => ({...await read(), cursorX: 2});
  assert.equal((await navigateSession('%1', child, pane)).ok, false);
  assert.equal(pane.sent.length, 0);
});

test('a missing exact UUID closes only the known picker without selecting another agent', async () => {
  const pane = new FakePane();
  assert.equal((await navigateSession('%1', absent, pane)).ok, false);
  assert.equal(pane.current, root);
  assert.equal(pane.picker, false);
});

test('reports delivery without claiming confirmation when the final view is unobservable', async () => {
  const pane = new FakePane();
  pane.refuseSwitch = true;
  const result = await navigateSession('%1', child, pane);
  assert.equal(result.ok, true);
  assert.equal(result.confirmed, false);
  assert.match(result.message, /requested/i);
  assert.equal(pane.current, root);
  assert.equal(pane.sent.filter(key=>key==='/subagents').length,1);
});

test('a restored target draft remains intact without reopening the picker', async () => {
  const pane = new FakePane();
  pane.targetDraft = 'target draft';
  const result = await navigateSession('%1', child, pane);
  assert.equal(result.ok, true);
  assert.equal(result.confirmed, false);
  assert.equal(pane.current, child);
  assert.equal(pane.draft, 'target draft');
  assert.match(result.message, /requested/i);
  assert.equal(pane.sent.filter(key=>key==='/subagents').length,1);
});

test('invalid identifiers and missing tmux bindings never send keys', async () => {
  const pane = new FakePane();
  for (const [target, id] of [[undefined, child], ['%1;other', child], ['%1', '/quit\n']]) {
    assert.equal((await navigateSession(target, id!, pane)).ok, false);
  }
  assert.equal(pane.sent.length, 0);
});

test('a popup replacing the expected composer receives no command', async () => {
  const pane = new FakePane();
  pane.readPane = async () => ({capture: 'Approve command?\n› 1. Yes\n  2. No', cursorX:2, cursorY:1, command:'codex', inMode:false});
  assert.equal((await navigateSession('%1', child, pane)).ok, false);
  assert.equal(pane.sent.length, 0);
});

test('indented picker rows still select only the exact UUID', async () => {
  const pane = new FakePane();
  const read = pane.readPane.bind(pane);
  pane.readPane = async () => {
    const snapshot = await read();
    return {...snapshot, capture: pane.picker ? snapshot.capture.replace(/^([› ]) (\d+)\./gm, '  $1 $2.') : snapshot.capture};
  };
  assert.equal((await navigateSession('%1', child, pane)).ok, true);
  assert.equal(pane.current, child);
});

test('allows native paste-burst suppression to expire before submitting the command', async () => {
  const pane = new FakePane();
  let burstAge = 1000;
  const send = pane.sendKeys.bind(pane);
  pane.sendKeys = async (target, keys, literal) => {
    if (literal) burstAge = 0;
    if (!literal && keys.includes('Enter') && !pane.picker && burstAge < 120) { pane.draft += '\n'; return; }
    await send(target, keys, literal);
  };
  pane.wait = async (ms: number) => { burstAge += ms; };
  assert.equal((await navigateSession('%1', child, pane)).ok, true);
  assert.equal(pane.current, child);
});

test('switching opens the picker once and batches movement to a visible exact target', async () => {
  const pane = new FakePane();
  pane.ids = Array.from({length:12},(_,i)=>`00000000-0000-0000-0000-${String(i+1).padStart(12,'0')}`);
  pane.current=pane.ids[8];
  const batches:string[][]=[];
  const send=pane.sendKeys.bind(pane);
  pane.sendKeys=async(target,keys,literal)=>{batches.push(keys);await send(target,keys,literal);};
  assert.equal((await navigateSession('%1',pane.ids[11],pane)).ok,true);
  assert.equal(pane.current,pane.ids[11]);
  assert.equal(pane.sent.filter(key=>key==='/subagents').length,1,'no verification popup after switching');
  assert.ok(!pane.sent.includes('Home'),'do not reset selection before a visible target');
  assert.ok(batches.some(keys=>keys.length===3 && keys.every(key=>key==='Down')),'visible movement is one batch');
});
test('clicking the current agent closes the picker without walking the list',async()=>{
  const pane=new FakePane();pane.current=child;
  assert.equal((await navigateSession('%1',child,pane)).ok,true);
  assert.ok(!pane.sent.includes('Home') && !pane.sent.includes('Down'));
});

test('a batch disrupted by a picker refresh never submits the wrong agent',async()=>{
  const pane=new FakePane();
  pane.ids=[root,child,absent];
  const send=pane.sendKeys.bind(pane);
  pane.sendKeys=async(target,keys,literal)=>{
    await send(target,keys,literal);
    if (keys.length===2 && keys.every(key=>key==='Down')) pane.selected=1;
  };
  const result=await navigateSession('%1',absent,pane);
  assert.equal(result.ok,false);
  assert.equal(pane.current,root);
  assert.equal(pane.sent.filter(key=>key==='Enter').length,1,'only opens picker; never submits wrong row');
});
test('a switch request with a picker that stays open is reported as a failure',async()=>{
  const pane=new FakePane();
  const send=pane.sendKeys.bind(pane);
  pane.sendKeys=async(target,keys,literal)=>{
    if(pane.picker && keys.includes('Enter')) return;
    await send(target,keys,literal);
  };
  const result=await navigateSession('%1',child,pane);
  assert.equal(result.ok,false);
  assert.match(result.message,/did not close/);
  assert.equal(pane.current,root);
  assert.equal(pane.sent.filter(key=>key==='/subagents').length,1);
});
