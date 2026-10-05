/**
 * Typing in the panel goes to Codex.
 *
 * The panel takes no plain keys: its commands are the tmux prefix's (see
 * panel-command.ts). A key or a paste that reaches the panel's pane anyway
 * (focus left there by a click, Shift+F12 or a closed overlay) is passed on
 * to the main Codex pane as it came, and the focus goes with it, so the next
 * keystrokes reach Codex directly.
 *
 * Keys go byte for byte (`send-keys -H`), one call for all the keys of one
 * read. A paste goes through a tmux buffer instead (`load-buffer` from stdin,
 * then `paste-buffer -p`, which keeps it a bracketed paste): its hex would
 * double its size and run into the command-line limit. `-r` keeps the body's
 * line endings as the terminal sent them. Forwards run one at a time, in
 * order: keys typed faster than the focus moves all land here, and two
 * forwards at once would interleave them.
 */

export type ForwardItem = { kind: 'keys'; text: string } | { kind: 'paste'; text: string };

/** The tmux buffer a paste travels in; deleted as it is pasted. */
export const FORWARD_BUFFER = 'codex-hud-fwd';

export interface TmuxCall {
  args: string[];
  /** What the call reads on stdin: a paste's body. */
  input?: string;
}

/** Keys typed one after another become one item, so one read is one `send-keys`. */
export function mergeForward(items: ForwardItem[]): ForwardItem[] {
  const merged: ForwardItem[] = [];
  for (const item of items) {
    if (!item.text) continue;
    const last = merged[merged.length - 1];
    if (item.kind === 'keys' && last?.kind === 'keys') last.text += item.text;
    else merged.push({ ...item });
  }
  return merged;
}

/** The tmux calls that deliver `items` to `pane` and give it the focus: the move rides on the last call. */
export function forwardCalls(pane: string, items: ForwardItem[]): TmuxCall[] {
  const calls: TmuxCall[] = mergeForward(items).map((item) =>
    item.kind === 'keys'
      ? {
          args: [
            'send-keys',
            '-t',
            pane,
            '-H',
            ...Array.from(Buffer.from(item.text, 'utf8'), (b) => b.toString(16).padStart(2, '0')),
          ],
        }
      : {
          args: [
            'load-buffer',
            '-b',
            FORWARD_BUFFER,
            '-',
            ';',
            'paste-buffer',
            '-p',
            '-r',
            '-d',
            '-b',
            FORWARD_BUFFER,
            '-t',
            pane,
          ],
          input: item.text,
        }
  );
  if (calls.length) calls[calls.length - 1].args.push(';', 'select-pane', '-t', pane);
  return calls;
}

/** One forward at a time, in the order asked. */
export class KeyForwarder {
  private chain: Promise<void> = Promise.resolve();
  constructor(
    private readonly pane: () => string | undefined,
    private readonly run: (call: TmuxCall) => Promise<void>
  ) {}
  send(items: ForwardItem[]): Promise<void> {
    const pane = this.pane();
    if (!pane || !items.length) return this.chain;
    const calls = forwardCalls(pane, items);
    this.chain = this.chain.then(async () => {
      for (const call of calls) {
        try {
          await this.run(call);
        } catch {
          /* A pane that went away takes nothing; the next forward tries again. */
        }
      }
    });
    return this.chain;
  }
}
