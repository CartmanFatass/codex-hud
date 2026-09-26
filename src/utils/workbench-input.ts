/** Stream decoder: terminal escape sequences may arrive split or batched. */
export type WorkbenchInput = { type: 'key'; key: string } | {
  type: 'mouse'; x: number; y: number; button: 'left' | 'wheel-up' | 'wheel-down';
};

const KEYS: Record<string, string> = {
  j: 'down', k: 'up', h: 'left', l: 'right', g: 'home', G: 'end',
  '\t': 'tab', '\r': 'enter', '\n': 'enter', ' ': 'enter',
  q: 'close', Q: 'close', '\x03': 'close', '\x04': 'close',
  a: 'show-all', v: 'detail-toggle', r: 'reset', ',': 'settings', m: 'main', o: 'open-session', f: 'filter', '/': 'filter', s: 'sort', z: 'zoom', '?': 'help',
  x: 'pane-close', '-': 'pane-fold',
  '[': 'previous-tab', ']': 'next-tab', t: 'next-tab',
  '1': 'agents', '2': 'details', '3': 'changes', '4': 'activity',
};
const ESCAPES: Record<string, string> = {
  '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left',
  '\x1bOA': 'up', '\x1bOB': 'down', '\x1bOC': 'right', '\x1bOD': 'left',
  '\x1b[Z': 'shift-tab', '\x1b[5~': 'page-up', '\x1b[6~': 'page-down',
  '\x1b[H': 'home', '\x1b[F': 'end', '\x1bOH': 'home', '\x1bOF': 'end',
  '\x1b[1~': 'home', '\x1b[4~': 'end', '\x1b[7~': 'home', '\x1b[8~': 'end',
};

export class WorkbenchInputDecoder {
  private pending = '';
  private pasting = false;
  constructor(private readonly profile: 'workbench' | 'monitor' = 'workbench') {}
  push(chunk: Buffer): WorkbenchInput[] {
    this.pending += chunk.toString('utf8');
    const inputs: WorkbenchInput[] = [];
    while (this.pending.length) {
      if (this.pasting) {
        const end = this.pending.indexOf('\x1b[201~');
        if (end < 0) {
          // Only a possible split end delimiter needs retaining, not the paste.
          this.pending = this.pending.slice(-5);
          break;
        }
        this.pending = this.pending.slice(end + 6);
        this.pasting = false;
        continue;
      }
      if (this.pending.startsWith('\x1b[200~')) {
        this.pending = this.pending.slice(6);
        this.pasting = true;
        continue;
      }
      if (this.pending[0] !== '\x1b') {
        const key = this.profile === 'monitor' && this.pending[0] === '2' ? 'worktrees'
          : this.profile === 'monitor' && this.pending[0] === '4' ? 'details' : KEYS[this.pending[0]];
        this.pending = this.pending.slice(1);
        if (key) inputs.push({ type: 'key', key });
        continue;
      }
      const mouse = this.pending.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
      if (mouse) {
        const code = Number(mouse[1]);
        const button = (code & 64) ? ((code & 1) ? 'wheel-down' : 'wheel-up') : (code & 3) === 0 ? 'left' : null;
        if (button && mouse[4] === 'M' && !(code & 32)) {
          inputs.push({ type: 'mouse', button, x: Number(mouse[2]) - 1, y: Number(mouse[3]) - 1 });
        }
        this.pending = this.pending.slice(mouse[0].length);
        continue;
      }
      const escape = this.pending.match(/^\x1b(?:\[[0-?]*[ -/]*[@-~]|O[A-Za-z])/);
      if (escape) {
        const key = ESCAPES[escape[0]];
        if (key) inputs.push({ type: 'key', key });
        this.pending = this.pending.slice(escape[0].length);
        continue;
      }
      if (this.pending.length === 1 || /^\x1b(?:\[[0-?]*[ -/]*|O)$/.test(this.pending)) break;
      this.pending = this.pending.slice(1);
    }
    if (this.pending.length > 256) this.pending = '';
    return inputs;
  }
  flushEscape(): WorkbenchInput[] {
    const bare = this.pending === '\x1b';
    if (bare) this.pending = '';
    return bare ? [{ type: 'key', key: 'escape' }] : [];
  }
}
