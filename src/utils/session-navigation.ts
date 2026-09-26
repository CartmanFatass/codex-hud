import { execFile } from 'node:child_process';

export interface NavigationPane {
  capture: string;
  cursorX: number;
  cursorY: number;
  command: string;
  inMode: boolean;
}
export interface NavigationAdapter {
  readPane(pane: string): Promise<NavigationPane>;
  sendKeys(pane: string, keys: string[], literal?: boolean): Promise<void>;
  focusPane(pane: string): Promise<void>;
  wait(ms: number): Promise<void>;
}
/** ok means the selection was submitted; confirmed is true only when the
 * picker already identified that session as current. Never reopen it just to verify. */
export interface NavigationResult { ok: boolean; message: string; sessionId?: string; confirmed?: boolean }

/**
 * The thread to show. Codex prints each thread's id beside its name in
 * /subagents, and whenever it does, the id alone decides. A pane too narrow
 * for that column shows names only; `label` is then matched instead, so pass
 * it only when no other thread in the session prints the same name.
 */
export interface NavigationTarget { id: string; label?: string }

const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const activePanes = new Set<string>();
const plain = (text: string) => text.replace(/\x1b\[[0-9;:]*m/g, '');
/** Codex wraps a long name at a space or mid-word, so names compare with no whitespace at all. */
const squash = (text: string) => text.replace(/\s+/g, '');
/** The composer prompt: "›", or "»" at Ultra reasoning effort. */
const PROMPT = /^\s*[›»] /;

function tmux(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(process.env.CODEX_HUD_TMUX_BIN || 'tmux', args,
      { encoding: 'utf8', timeout: 1500, maxBuffer: 256 * 1024, windowsHide: true },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

const terminalAdapter: NavigationAdapter = {
  async readPane(pane) {
    const metadata = (await tmux(['display-message', '-p', '-t', pane,
      '#{pane_current_command}\t#{pane_in_mode}\t#{cursor_x}\t#{cursor_y}'])).trim().split('\t');
    const capture = await tmux(['capture-pane', '-p', '-e', '-t', pane]);
    return { capture, command: metadata[0], inMode: metadata[1] !== '0', cursorX: Number(metadata[2]), cursorY: Number(metadata[3]) };
  },
  async sendKeys(pane, keys, literal = false) {
    await tmux(['send-keys', '-t', pane, ...(literal ? ['-l'] : []), ...keys]);
  },
  async focusPane(pane) { await tmux(['select-pane', '-t', pane]); },
  async wait(ms) { await new Promise(resolve => setTimeout(resolve, ms)); },
};

function isCodex(pane: NavigationPane): boolean {
  return /(?:^|[/\\])codex(?:\.exe)?$/.test(pane.command) && !pane.inMode;
}

/** Codex renders an empty enabled composer with a dim placeholder, whether
 * it reads "Ask Codex to do anything" or, watching a sub-agent, "direct input
 * is disabled" (/subagents is still accepted there). A draft at cursor offset
 * zero has normal text; input-disabled prompts are dim. Never infer an empty
 * draft from its words or from the cursor alone.
 */
function emptyComposer(pane: NavigationPane): boolean {
  const line = pane.capture.split('\n')[pane.cursorY];
  if (!line) return false;
  let dim = false;
  const chars: Array<{text: string; dim: boolean}> = [];
  for (const match of line.matchAll(/\x1b\[([0-9;]*)m|([^])/gu)) {
    if (match[1] !== undefined) {
      const codes = (match[1] || '0').split(';').map(Number);
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        if (code === 0 || code === 22) dim = false;
        else if (code === 2) dim = true;
        else if (code === 38 || code === 48 || code === 58) i += codes[i + 1] === 2 ? 4 : 2;
      }
    } else chars.push({ text: match[2], dim });
  }
  const text = chars.map(ch => ch.text).join('');
  const prefix = PROMPT.exec(text)?.[0];
  if (!prefix || pane.cursorX !== prefix.length || chars[prefix.search(/[›»]/)]?.dim) return false;
  const content = chars.slice(prefix.length).filter(ch => ch.text.trim());
  return content.length > 0 && content.every(ch => ch.dim);
}

interface PickerRow {
  number: number;
  selected: boolean;
  current: boolean;
  /** The thread id, or undefined when the pane is too narrow for Codex to print it. */
  id?: string;
  /** The printed name, squashed, without its "(current)" or "(default)" marker. */
  label: string;
}
interface PickerView {
  rows: PickerRow[];
  /** Codex drew its "↓" marker: more rows sit below the visible ones. */
  below: boolean;
}

const ROW_START = /^\s*(›)?\s*(\d+)\.\s(.*)$/;
const SCROLL_MARK = /^\s*([↑↓])\s*$/;

function pickerRow(start: RegExpExecArray, text: string): PickerRow {
  // Rows open with a status dot; the id, when printed, is the last column and
  // wraps at a hyphen onto an indented line, so it may span two tokens.
  const tokens = text.replace(/^\s*[•●◦]\s+/, '').split(/\s+/).filter(Boolean);
  let id: string | undefined;
  let name = tokens;
  for (let k = 1; k <= Math.min(3, tokens.length - 1); k++) {
    const joined = tokens.slice(-k).join('');
    if (UUID_ONLY.test(joined)) { id = joined.toLowerCase(); name = tokens.slice(0, -k); break; }
  }
  let label = squash(name.join(''));
  const marker = /\((?:current|default)\)$/.exec(label)?.[0];
  if (marker) label = label.slice(0, -marker.length);
  return { number: Number(start[2]), selected: start[1] === '›', current: marker === '(current)', id, label };
}

/**
 * Read the /subagents picker off the pane, or null when it is not showing.
 * Verified against Codex rust-v0.157.0 (tui/src/app/session_lifecycle.rs,
 * bottom_pane/list_selection_view.rs) and by capturing it live:
 *
 *       Subagents
 *       Select an agent to watch. alt+← previous, alt+→ next.
 *
 *     ↑
 *     › 1. • Main [default] (current)         01a0db17-a6de-7422-a56e-4b408d769794
 *       2. • /root/essays_2020_2021           01a0db3d-b22d-7922-8439-8865fac4a8e4
 *     ↓
 *       enter select · esc back
 *
 * Eight rows show at a time. Below about 80 columns the id wraps onto a
 * second line; below about 63 it is not printed and long names wrap instead.
 * Codex 0.154 drew the same picker without the dot, over the footer "Press
 * enter to confirm or esc to go back"; either footer is the last line drawn.
 */
function pickerView(pane: NavigationPane): PickerView | null {
  if (!isCodex(pane)) return null;
  const lines = plain(pane.capture).split('\n');
  let footer = lines.length - 1;
  while (footer >= 0 && !lines[footer].trim()) footer--;
  if (footer < 0 || !/\besc\b.*\bback\b/i.test(lines[footer])) return null;
  let title = footer - 1;
  while (title >= 0 && lines[title].trim() !== 'Subagents') title--;
  if (title < 0) return null;
  const rows: PickerRow[] = [];
  let header = '';
  let below = false;
  let open: { start: RegExpExecArray; text: string } | null = null;
  const close = () => { if (open) rows.push(pickerRow(open.start, open.text)); open = null; };
  for (const line of lines.slice(title + 1, footer)) {
    const start = ROW_START.exec(line);
    const mark = SCROLL_MARK.exec(line);
    if (start && (rows.length || open || header)) { close(); open = { start, text: start[3] }; }
    else if (mark || !line.trim()) { close(); if (mark?.[1] === '↓') below = true; }
    else if (open && /^\s/.test(line)) open.text += `\n${line}`;
    else if (!open && !rows.length) header += line;
    else return null; // Not a layout this parser was written against.
  }
  close();
  if (!squash(header).startsWith('Selectanagenttowatch.')) return null;
  return { rows, below };
}

/** Verified against OpenAI Codex rust-v0.154.0 and rust-v0.157.0.
 * The picker is NOT searchable and /subagents does NOT take inline arguments.
 * No live-session inputs are sent until an empty enabled composer or this exact picker is seen.
 */
export async function navigateSession(mainPane: string | null | undefined, target: NavigationTarget | string,
  adapter: NavigationAdapter = terminalAdapter): Promise<NavigationResult> {
  const fail = (message: string): NavigationResult => ({ ok: false, message });
  const wanted = typeof target === 'string' ? { id: target } : target;
  if (!mainPane || !/^%\d+$/.test(mainPane)) return fail('No valid Codex tmux pane is connected.');
  if (!UUID_ONLY.test(wanted.id)) return fail('The selected agent has no valid session ID.');
  if (activePanes.has(mainPane)) return fail('A thread switch is already in progress.');
  const id = wanted.id.toLowerCase();
  const label = wanted.label?.trim() ? squash(wanted.label) : undefined;
  activePanes.add(mainPane);
  const deadline = Date.now() + 8000;
  const read = () => {
    if (Date.now() > deadline) throw new Error('navigation timeout');
    return adapter.readPane(mainPane);
  };
  const keys = (...keys: string[]) => adapter.sendKeys(mainPane, keys);
  const waitFor = async (check: (pane: NavigationPane) => boolean): Promise<NavigationPane | null> => {
    for (let i = 0; i < 30; i++) {
      const pane = await read();
      if (!isCodex(pane)) return null;
      if (check(pane)) return pane;
      await adapter.wait(50);
    }
    return null;
  };
  /**
   * The target among these rows: undefined when it is not among them, null
   * when the rows cannot tell (no ids printed and no label to go by, or two
   * rows printing the label).
   */
  const targetIn = (rows: PickerRow[]): PickerRow | undefined | null => {
    const found = rows.some(row => row.id) ? rows.filter(row => row.id === id)
      : label ? rows.filter(row => row.label === label) : null;
    return found === null || found.length > 1 ? null : found[0];
  };
  const selectedTarget = (pane: NavigationPane | null): PickerRow | undefined => {
    const rows = pane ? pickerView(pane)?.rows : undefined;
    const found = rows ? targetIn(rows) : undefined;
    return found?.selected ? found : undefined;
  };
  const closePicker = async () => { if (pickerView(await read()) !== null) await keys('Escape'); };
  const openPicker = async (): Promise<NavigationPane | null> => {
    const before = await read();
    if (pickerView(before) !== null) return before;
    if (!isCodex(before) || !emptyComposer(before)) return null;
    await adapter.sendKeys(mainPane, ['/subagents'], true);
    // Codex paste_burst.rs suppresses Enter for 120ms after rapid text input.
    // Let it expire, then verify the composer again before submitting.
    await adapter.wait(150);
    const typed = await waitFor(pane => {
      const line = plain(pane.capture.split('\n')[pane.cursorY] ?? '');
      return /^\s*[›»] \/subagents\s*$/.test(line);
    });
    if (!typed) return null; // Never submit an unexpected composer or clear its contents.
    await keys('Enter');
    return waitFor(pane => pickerView(pane) !== null);
  };
  try {
    const first = await read();
    if (!isCodex(first)) return fail('The main pane is not an active Codex composer; leave copy mode or other terminal views first.');
    if (pickerView(first) === null && !emptyComposer(first)) return fail('Codex has a draft or another view open. Keep the draft safe and switch when its composer is empty.');
    let pane = await openPicker();
    const opened = pane ? pickerView(pane) : null;
    if (!pane || !opened) return fail('Could not open the verified Codex Subagents picker.');
    if (targetIn(opened.rows) === null) {
      await closePicker();
      return fail(label
        ? 'Two Codex threads print this name; widen the Codex pane so their IDs show, then try again.'
        : 'The Codex pane is too narrow to show agent IDs; widen it, then try again.');
    }
    // Start from the current row. Go back to the top only when the target is
    // not already on screen; from there, page down until it is.
    if (targetIn(opened.rows) === undefined && !opened.rows.some(row => row.selected && row.number === 1)) {
      await keys('Home');
      pane = await waitFor(value => pickerView(value)?.rows.some(row => row.selected && row.number === 1) === true);
    }
    for (let pages = 0; pane && pages < 50; pages++) {
      const view = pickerView(pane);
      const selected = view?.rows.find(row => row.selected);
      const found = view ? targetIn(view.rows) : null;
      if (!view || !selected || found === null) { pane = null; break; }
      if (found) {
        const delta = found.number - selected.number;
        // One tmux delivery lets Codex coalesce the intermediate row redraws.
        // selectedTarget rechecks the row afterwards in case the list changed.
        if (delta) {
          await keys(...Array<string>(Math.abs(delta)).fill(delta > 0 ? 'Down' : 'Up'));
          pane = await waitFor(value => selectedTarget(value) !== undefined);
        }
        break;
      }
      // Page movement stops at the last row rather than wrapping to the top.
      if (!view.below) { pane = null; break; }
      await keys('PageDown');
      pane = await waitFor(value => {
        const rows = pickerView(value)?.rows;
        return !rows || rows.some(row => row.selected && row.number > selected.number);
      });
    }
    if (!selectedTarget(pane)) {
      await closePicker();
      return fail('The agent was not found in the Codex Subagents picker.');
    }
    // Re-read before submitting in case live picker refresh changed the selection.
    const confirmed = selectedTarget(await read());
    if (!confirmed) { await closePicker(); return fail('Codex selection changed; try the thread switch again.'); }
    if (confirmed.current) {
      await closePicker();
      await adapter.focusPane(mainPane);
      return {ok:true,message:'Codex is already showing this thread.',sessionId:id,confirmed:true};
    }
    await keys('Enter');
    const switched = await waitFor(value => pickerView(value) === null);
    if (!switched) return fail('Codex did not close the picker after the switch request.');
    // Opening /subagents again caused a second popup, redraw and transcript
    // jump. A closed picker acknowledges delivery, not proof of the final view.
    // Preserve any restored target draft and report only what we can observe.
    await adapter.focusPane(mainPane);
    return {ok:true,message:'Codex thread switch requested.',sessionId:id,confirmed:false};
  } catch {
    // Do not send cleanup keys into a pane whose current view cannot be verified.
    return fail('Could not communicate with the Codex tmux pane.');
  } finally { activePanes.delete(mainPane); }
}
