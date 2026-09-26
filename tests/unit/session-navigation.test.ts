import test from 'node:test';
import assert from 'node:assert/strict';
import { navigateSession, type NavigationAdapter, type NavigationPane } from '../../src/utils/session-navigation.js';

const root = '00000000-0000-0000-0000-000000000001';
const child = '00000000-0000-0000-0000-000000000002';
const absent = '00000000-0000-0000-0000-000000000099';

/**
 * A Codex pane drawing the /subagents picker the way 0.157 does: a status dot
 * before each name, the id as the last column, eight rows at a time with ↑/↓
 * markers, the id wrapped below 80 columns and left out below 63.
 */
class FakePane implements NavigationAdapter {
  current = root;
  selected = 0;
  top = 0;
  visible = 8;
  width = 120;
  prompt = '›';
  placeholder = 'Ask Codex to do anything';
  footer = 'enter select · esc back';
  dot = '• ';
  picker = false;
  draft = '';
  targetDraft = '';
  command = 'codex';
  inMode = false;
  refuseSwitch = false;
  focused = false;
  sent: string[] = [];
  ids = [root, child];
  names: Record<string, string> = {};
  name(i: number): string { return i === 0 ? 'Main [default]' : this.names[this.ids[i]] ?? (i === 1 ? '/root/worker' : `/root/worker_${i}`); }
  private rows(): string[] {
    const names = this.ids.map((id, i) => `${this.dot}${this.name(i)}${this.current === id ? ' (current)' : ''}`);
    const column = Math.max(...names.map((name, i) => `› ${i + 1}. `.length + name.length)) + 2;
    const lines: string[] = [];
    for (let i = this.top; i < Math.min(this.ids.length, this.top + this.visible); i++) {
      const head = `${this.selected === i ? '›' : ' '} ${i + 1}. ${names[i]}`;
      const id = this.ids[i];
      if (this.width < 63) lines.push(head);
      else if (this.width < 80) lines.push(`${head.padEnd(column)}${id.slice(0, 24)}`, `${' '.repeat(column)}${id.slice(24)}`);
      else lines.push(`${head.padEnd(column)}${id}`);
    }
    return lines;
  }
  private show(index: number): void {
    this.selected = index;
    if (this.selected < this.top) this.top = this.selected;
    if (this.selected >= this.top + this.visible) this.top = this.selected - this.visible + 1;
  }
  async readPane(): Promise<NavigationPane> {
    const composer = `\x1b[1m${this.prompt}\x1b[0m ${this.draft || `\x1b[2m${this.placeholder}\x1b[0m`}`;
    const capture = this.picker ? ['Transcript', '  Subagents', '  Select an agent to watch. alt+← previous, alt+→ next.', '',
      this.top > 0 ? '↑' : '', ...this.rows(), this.top + this.visible < this.ids.length ? '↓' : '', `  ${this.footer}`].join('\n')
      : `Transcript\n${composer}\n\n  ? for shortcuts`;
    return { capture, cursorX: 2 + this.draft.length, cursorY: 1, command: this.command, inMode: this.inMode };
  }
  async sendKeys(_pane: string, keys: string[], literal = false): Promise<void> {
    this.sent.push(...keys);
    if (literal) { this.draft += keys.join(''); return; }
    const last = this.ids.length - 1;
    for (const key of keys) {
      if (key === 'Enter' && this.picker) {
        if (!this.refuseSwitch) this.current = this.ids[this.selected];
        this.picker = false;
        this.draft = this.current === child ? this.targetDraft : '';
      } else if (key === 'Enter' && this.draft === '/subagents') {
        this.picker = true; this.draft = ''; this.top = 0; this.show(Math.max(0, this.ids.indexOf(this.current)));
      } else if (key === 'Escape' && this.picker) this.picker = false;
      else if (key === 'Home' && this.picker) this.show(0);
      else if (key === 'PageDown' && this.picker) this.show(Math.min(last, this.selected + this.visible));
      else if (key === 'Down' && this.picker) this.show(this.selected === last ? 0 : this.selected + 1);
      else if (key === 'Up' && this.picker) this.show(this.selected === 0 ? last : this.selected - 1);
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

test('the picker Codex 0.154 drew, with its older footer and no status dot, still works', async () => {
  const pane = new FakePane();
  pane.footer = 'Press enter to confirm or esc to go back';
  pane.dot = '';
  assert.equal((await navigateSession('%1', child, pane)).ok, true);
  assert.equal(pane.current, child);
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

test('the » prompt of Ultra effort and a sub-agent view both count as an empty composer', async () => {
  const ultra = new FakePane();
  ultra.prompt = '»';
  assert.equal((await navigateSession('%1', child, ultra)).ok, true);
  assert.equal(ultra.current, child);
  // Watching a sub-agent, Codex blocks messages but still takes /subagents.
  const watching = new FakePane();
  watching.current = child;
  watching.placeholder = 'Viewing sub-agent — direct input is disabled';
  assert.equal((await navigateSession('%1', root, watching)).ok, true);
  assert.equal(watching.current, root);
});

test('a missing exact UUID closes only the known picker without selecting another agent', async () => {
  const pane = new FakePane();
  assert.equal((await navigateSession('%1', absent, pane)).ok, false);
  assert.equal(pane.current, root);
  assert.equal(pane.picker, false);
});

test('an id wrapped onto a second line still picks out its agent', async () => {
  const pane = new FakePane();
  pane.width = 70;
  pane.ids = [root, absent, child];
  assert.equal((await navigateSession('%1', child, pane)).ok, true);
  assert.equal(pane.current, child);
});

test('a pane too narrow for ids switches by the name Codex prints, and only by it', async () => {
  const pane = new FakePane();
  pane.width = 50;
  pane.ids = [root, absent, child];
  pane.names = { [absent]: '/root/audit_code_paths', [child]: '/root/audit_state_paths' };
  assert.equal((await navigateSession('%1', { id: child, label: '/root/audit_state_paths' }, pane)).ok, true);
  assert.equal(pane.current, child);
  // Back to the main thread, which is named the same way in every session.
  const back = await navigateSession('%1', { id: root, label: 'Main [default]' }, pane);
  assert.equal(back.ok, true);
  assert.equal(pane.current, root);
  // Clicking the agent already on screen is recognised by its "(current)" mark.
  pane.current = child;
  const again = await navigateSession('%1', { id: child, label: '/root/audit_state_paths' }, pane);
  assert.equal(again.confirmed, true);
});

test('with neither ids on screen nor a name to go by, a narrow pane refuses instead of guessing', async () => {
  const pane = new FakePane();
  pane.width = 50;
  const result = await navigateSession('%1', child, pane);
  assert.equal(result.ok, false);
  assert.match(result.message, /narrow/);
  assert.equal(pane.current, root);
  assert.equal(pane.picker, false);
  assert.equal(pane.sent.filter(key => key === 'Enter').length, 1, 'only the Enter that opened the picker');
});

test('two rows printing the same name are never told apart by guesswork', async () => {
  const pane = new FakePane();
  pane.width = 50;
  pane.ids = [root, absent, child];
  pane.names = { [absent]: 'Robie [explorer]', [child]: 'Robie [explorer]' };
  const result = await navigateSession('%1', { id: child, label: 'Robie [explorer]' }, pane);
  assert.equal(result.ok, false);
  assert.equal(pane.current, root);
  assert.equal(pane.picker, false);
});

test('a name Codex wrapped over two lines is read back whole', async () => {
  const pane = new FakePane();
  pane.width = 30;
  pane.names = { [child]: '/root/analyze_2022_enforcement' };
  const read = pane.readPane.bind(pane);
  pane.readPane = async () => {
    const snapshot = await read();
    return {...snapshot, capture: snapshot.capture.replace('/root/analyze_2022_enforcement', '/root/\n       analyze_2022_enforceme\n       nt')};
  };
  assert.equal((await navigateSession('%1', { id: child, label: '/root/analyze_2022_enforcement' }, pane)).ok, true);
  assert.equal(pane.current, child);
});

test('agents below the fold are reached a page at a time, never by wrapping around', async () => {
  const pane = new FakePane();
  pane.ids = Array.from({length: 31}, (_, i) => `00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`);
  pane.current = pane.ids[0];
  assert.equal((await navigateSession('%1', pane.ids[26], pane)).ok, true);
  assert.equal(pane.current, pane.ids[26]);
  // Four pages reach the last row; the target is then on screen, a few rows up.
  assert.equal(pane.sent.filter(key => key === 'PageDown').length, 4);
  assert.ok(pane.sent.filter(key => key === 'Down' || key === 'Up').length < 8);
  // An agent that is not in the list ends the search at the last row.
  const before = pane.sent.length;
  assert.equal((await navigateSession('%1', absent, pane)).ok, false);
  assert.equal(pane.current, pane.ids[26]);
  assert.equal(pane.picker, false);
  assert.ok(!pane.sent.slice(before).includes('Down'), 'no row-by-row walk past the end');
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
  pane.visible = 12;
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
