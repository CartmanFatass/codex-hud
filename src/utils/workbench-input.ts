/** Stream decoder: terminal escape sequences may arrive split or batched. */
import { StringDecoder } from 'node:string_decoder';
import { PANEL_COMMAND_TAG, isPanelCommand, type PanelCommand } from './panel-command.js';

export type WorkbenchInput =
  /**
   * A key. `raw` (with `forward` on) is exactly what the terminal sent for
   * it, and `key` is '' for a key the panel has no name for.
   */
  | { type: 'key'; key: string; raw?: string }
  | { type: 'mouse'; x: number; y: number; button: 'left' | 'wheel-up' | 'wheel-down' }
  /** A bracketed paste's body (with `forward` on), markers excluded. */
  | { type: 'paste'; text: string }
  /** A command the tmux prefix table sent (see bin/codex-hud-keys). */
  | { type: 'command'; command: PanelCommand };

const KEYS: Record<string, string> = {
  j: 'down', k: 'up', h: 'left', l: 'right', g: 'home', G: 'end',
  '\t': 'tab', '\r': 'enter', '\n': 'enter', ' ': 'enter',
  q: 'close', Q: 'close', '\x03': 'close', '\x04': 'close',
  e: 'expand', a: 'show-all', v: 'detail-toggle', r: 'reset', ',': 'settings', m: 'main', o: 'open-session', f: 'filter', '/': 'filter', s: 'sort', z: 'zoom', '?': 'help', b: 'brief-toggle',
  x: 'pane-close',
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
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
/** The command channel's opening, an APC string no terminal sends as input. */
const COMMAND_OPEN = `\x1b_${PANEL_COMMAND_TAG}`;
/** The longest command body; anything longer is not one of ours. */
const COMMAND_MAX = 32;
/** A paste larger than this keeps its head; the rest is dropped, not buffered without end. */
const PASTE_MAX = 8 * 1024 * 1024;

export interface DecoderOptions {
  /**
   * Keep what is to be passed on: every key's bytes (`raw`), keys the panel
   * has no name for, and paste bodies. Off, the decoder only names keys.
   */
  forward?: boolean;
}

export class WorkbenchInputDecoder {
  private pending = '';
  private pasting = false;
  private paste = '';
  private readonly utf8 = new StringDecoder('utf8');
  private readonly forward: boolean;
  constructor(private readonly profile: 'workbench' | 'monitor' = 'workbench', options: DecoderOptions = {}) {
    this.forward = options.forward ?? false;
  }
  push(chunk: Buffer): WorkbenchInput[] {
    // A character split across two reads is held back, not mangled.
    this.pending += this.utf8.write(chunk);
    const inputs: WorkbenchInput[] = [];
    const key = (name: string | undefined, raw: string) => {
      if (this.forward) inputs.push({ type: 'key', key: name ?? '', raw });
      else if (name) inputs.push({ type: 'key', key: name });
    };
    while (this.pending.length) {
      if (this.pasting) {
        const end = this.pending.indexOf(PASTE_END);
        if (end < 0) {
          // Keep a possible split end marker; the body goes to the paste (or nowhere).
          const keep = Math.min(this.pending.length, PASTE_END.length - 1);
          this.collect(this.pending.slice(0, this.pending.length - keep));
          this.pending = this.pending.slice(this.pending.length - keep);
          break;
        }
        this.collect(this.pending.slice(0, end));
        this.pending = this.pending.slice(end + PASTE_END.length);
        this.pasting = false;
        if (this.forward) inputs.push({ type: 'paste', text: this.paste });
        this.paste = '';
        continue;
      }
      if (this.pending.startsWith(PASTE_START)) {
        this.pending = this.pending.slice(PASTE_START.length);
        this.pasting = true;
        this.paste = '';
        continue;
      }
      if (this.pending[0] !== '\x1b') {
        const ch = String.fromCodePoint(this.pending.codePointAt(0) ?? 0);
        const name = this.profile === 'monitor' && ch === '2' ? 'worktrees'
          : this.profile === 'monitor' && ch === '4' ? 'details'
            : this.profile === 'monitor' && ch === '5' ? 'timeline'
              // The monitor tells Space from Enter: on a card it opens the card.
              : this.profile === 'monitor' && ch === ' ' ? 'space' : KEYS[ch];
        this.pending = this.pending.slice(ch.length);
        key(name, ch);
        continue;
      }
      const command = this.command();
      if (command === 'wait') break;
      if (command) {
        if (command !== 'drop') inputs.push({ type: 'command', command });
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
        // Focus reports are the terminal talking to this pane, not a key.
        if (escape[0] !== '\x1b[I' && escape[0] !== '\x1b[O') key(ESCAPES[escape[0]], escape[0]);
        this.pending = this.pending.slice(escape[0].length);
        continue;
      }
      if (this.pending.length === 1 || /^\x1b(?:\[[0-?]*[ -/]*|O)$/.test(this.pending)) break;
      if (this.forward) {
        // Escape and one more character: Alt with that key, passed on whole.
        const ch = String.fromCodePoint(this.pending.codePointAt(1) ?? 0);
        key(undefined, '\x1b' + ch);
        this.pending = this.pending.slice(1 + ch.length);
        continue;
      }
      this.pending = this.pending.slice(1);
    }
    if (this.pending.length > 256) this.pending = '';
    return inputs;
  }
  /**
   * A command at the head of the input: the command, 'drop' for one that
   * names nothing the panel knows, 'wait' while the head could still become
   * one, or null when it is not one (then the bytes are ordinary keys).
   */
  private command(): PanelCommand | 'drop' | 'wait' | null {
    const head = this.pending;
    if (!head.startsWith('\x1b_')) return null;
    if (head.length < COMMAND_OPEN.length) return COMMAND_OPEN.startsWith(head) ? 'wait' : null;
    if (!head.startsWith(COMMAND_OPEN)) return null;
    const body = head.slice(COMMAND_OPEN.length).match(/^([a-z0-9-]{0,33})(\x1b\\?)?/);
    if (!body || body[1].length > COMMAND_MAX) return null;
    if (body[2] !== '\x1b\\') {
      // Still arriving: the body so far is all allowed characters.
      const rest = head.slice(COMMAND_OPEN.length + body[1].length);
      return rest === '' || rest === '\x1b' ? 'wait' : null;
    }
    this.pending = head.slice(COMMAND_OPEN.length + body[0].length);
    return isPanelCommand(body[1]) ? body[1] : 'drop';
  }
  private collect(text: string): void {
    if (!this.forward || !text || this.paste.length >= PASTE_MAX) return;
    this.paste += text.slice(0, PASTE_MAX - this.paste.length);
  }
  /**
   * What is still held 40 ms after the last read: a bare Escape is the
   * Escape key, and the start of a command that never finished is keys.
   */
  flushEscape(): WorkbenchInput[] {
    if (this.pending === '\x1b') {
      this.pending = '';
      return [this.forward ? { type: 'key', key: 'escape', raw: '\x1b' } : { type: 'key', key: 'escape' }];
    }
    if (this.pending.startsWith('\x1b_') && !this.pasting) {
      // Not a command after all: Alt+_ and whatever followed it, passed on.
      const raw = this.pending;
      this.pending = '';
      return this.forward ? [{ type: 'key', key: '', raw }] : [];
    }
    return [];
  }
}
