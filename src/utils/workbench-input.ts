/** Stream decoder: terminal escape sequences may arrive split or batched. */
import { StringDecoder } from 'node:string_decoder';

export type WorkbenchInput =
  /**
   * A key. `key` is '' for a key the panel has no name for. `text` is the
   * character a printable key types (the workboard profile, the panel's own
   * keyboard), for the Control plane's model picker and confirmation dialog.
   */
  | { type: 'key'; key: string; text?: string }
  | { type: 'mouse'; x: number; y: number; button: 'left' | 'wheel-up' | 'wheel-down' };

const KEYS: Record<string, string> = {
  j: 'down',
  k: 'up',
  G: 'end',
  h: 'left',
  l: 'right',
  '\t': 'tab',
  '\r': 'enter',
  '\n': 'enter',
  ' ': 'enter',
  q: 'close',
  Q: 'close',
  '\x03': 'close',
  '\x04': 'close',
  a: 'show-all',
  v: 'detail-toggle',
  r: 'reset',
  s: 'settings-save',
  t: 'settings-test',
  ',': 'settings',
  o: 'open-session',
  // Home's next and previous card that needs the owner. `n` flags a to-try row, `g` goes to a job's tab, `+ - =` size Split: one meaning per key.
  '>': 'next-trouble',
  '<': 'previous-trouble',
  '?': 'help',
  b: 'brief-toggle',
  '1': 'agents',
  '3': 'changes',
  '4': 'details',
};
const ESCAPES: Record<string, string> = {
  '\x1b[A': 'up',
  '\x1b[B': 'down',
  '\x1b[C': 'right',
  '\x1b[D': 'left',
  '\x1bOA': 'up',
  '\x1bOB': 'down',
  '\x1bOC': 'right',
  '\x1bOD': 'left',
  '\x1b[Z': 'shift-tab',
  '\x1b[3~': 'place-remove',
  '\x1b[5~': 'page-up',
  '\x1b[6~': 'page-down',
  '\x1b[H': 'home',
  '\x1b[F': 'end',
  '\x1bOH': 'home',
  '\x1bOF': 'end',
  '\x1b[1~': 'home',
  '\x1b[4~': 'end',
  '\x1b[7~': 'home',
  '\x1b[8~': 'end',
};
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export class WorkbenchInputDecoder {
  private pending = '';
  private pasting = false;
  private readonly utf8 = new StringDecoder('utf8');
  constructor(private readonly profile: 'workbench' | 'monitor' | 'workboard' = 'workbench') {}
  push(chunk: Buffer): WorkbenchInput[] {
    // A character split across two reads is held back, not mangled.
    this.pending += this.utf8.write(chunk);
    const inputs: WorkbenchInput[] = [];
    const key = (name: string | undefined, text?: string) => {
      if (name || text) inputs.push({ type: 'key', key: name ?? '', ...(text ? { text } : {}) });
    };
    while (this.pending.length) {
      if (this.pasting) {
        const end = this.pending.indexOf(PASTE_END);
        if (end < 0) {
          const keep = Math.min(this.pending.length, PASTE_END.length - 1);
          this.pending = this.pending.slice(this.pending.length - keep);
          break;
        }
        this.pending = this.pending.slice(end + PASTE_END.length);
        this.pasting = false;
        continue;
      }
      if (this.pending.startsWith(PASTE_START)) {
        this.pending = this.pending.slice(PASTE_START.length);
        this.pasting = true;
        continue;
      }
      if (this.pending[0] !== '\x1b') {
        const ch = String.fromCodePoint(this.pending.codePointAt(0) ?? 0);
        const name =
          this.profile === 'workboard'
            ? ((
                {
                  // The digits switch no tab: `1`–`4` pick an option of an open question (`text` carries which); `f` is the Changes page `3` used to open.
                  '1': 'option',
                  '2': 'option',
                  '3': 'option',
                  '4': 'option',
                  f: 'changes',
                  '[': 'project-prev',
                  ']': 'project-next',
                  y: 'try-accept',
                  n: 'try-flag',
                  // Control plane: the place under the cursor (capitals go back).
                  c: 'role-preset',
                  C: 'role-preset-prev',
                  N: 'preset-copy',
                  R: 'preset-rename',
                  D: 'preset-delete',
                  p: 'place-harness',
                  P: 'place-harness-prev',
                  m: 'place-model',
                  M: 'place-model-prev',
                  e: 'place-thinking',
                  E: 'place-thinking-prev',
                  i: 'place-add',
                  '+': 'list-grow',
                  '-': 'list-shrink',
                  K: 'place-up',
                  J: 'place-down',
                  x: 'place-clear',
                  // A HUD job's micro-actions: `d` answers with the question's default on an expanded slab; `X` asks to stop it.
                  d: 'answer-default',
                  X: 'stop-job',
                  '\x7f': 'backspace',
                  '\b': 'backspace',
                  '\x12': 'model-refresh',
                  v: 'inspect',
                  ' ': 'inspect',
                  w: 'export-board',
                  '=': 'list-grow',
                } as Record<string, string>
              )[ch] ?? KEYS[ch])
            : KEYS[ch];
        this.pending = this.pending.slice(ch.length);
        key(name, this.profile === 'workboard' && ch >= ' ' && ch !== '\x7f' && !/[\x80-\x9f]/.test(ch) ? ch : undefined);
        continue;
      }
      if (this.pending.startsWith('\x1b\x1b')) {
        this.pending = this.pending.slice(1);
        key('escape');
        continue;
      }
      const mouse = this.pending.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
      if (mouse) {
        const code = Number(mouse[1]);
        const button =
          code & 64
            ? (code & 3) === 0
              ? 'wheel-up'
              : (code & 3) === 1
                ? 'wheel-down'
                : null
            : (code & 3) === 0
              ? 'left'
              : null;
        if (button && mouse[4] === 'M' && !(code & 32)) inputs.push({ type: 'mouse', button, x: Number(mouse[2]) - 1, y: Number(mouse[3]) - 1 });
        this.pending = this.pending.slice(mouse[0].length);
        continue;
      }
      const escape = this.pending.match(/^\x1b(?:\[[0-?]*[ -/]*[@-~]|O[A-Za-z])/);
      if (escape) {
        // Focus reports are the terminal talking to this pane, not a key.
        if (escape[0] !== '\x1b[I' && escape[0] !== '\x1b[O') key(ESCAPES[escape[0]]);
        this.pending = this.pending.slice(escape[0].length);
        continue;
      }
      if (this.pending.length === 1 || /^\x1b(?:\[[0-?]*[ -/]*|O)$/.test(this.pending)) break;
      this.pending = this.pending.slice(1);
    }
    if (this.pending.length > 256) this.pending = '';
    return inputs;
  }
  /** What is still held 40 ms after the last read: a bare Escape is the Escape key. */
  flushEscape(): WorkbenchInput[] {
    if (this.pending === '\x1b') {
      this.pending = '';
      return [{ type: 'key', key: 'escape' }];
    }
    return [];
  }
}
