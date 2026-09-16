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
/** ok means the exact-ID selection was submitted; confirmed is true only when
 * the picker already identified that session as current. Never reopen it just to verify. */
export interface NavigationResult { ok: boolean; message: string; sessionId?: string; confirmed?: boolean }

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const activePanes = new Set<string>();
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');

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

/** Codex 0.154 renders an empty enabled composer with a dim placeholder.
 * A draft at cursor offset zero has normal text; input-disabled prompts are dim.
 * Never infer an empty draft from its words or from the cursor alone.
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
  const prefix = /^\s*› /.exec(text)?.[0];
  if (!prefix || pane.cursorX !== prefix.length || chars[prefix.indexOf('›')]?.dim) return false;
  const content = chars.slice(prefix.length).filter(ch => ch.text.trim());
  return content.length > 0 && content.every(ch => ch.dim);
}

interface PickerRow { id: string; number: number; selected: boolean; current: boolean }
function pickerRows(pane: NavigationPane): PickerRow[] | null {
  if (!isCodex(pane)) return null;
  const lines = plain(pane.capture).split('\n');
  let title = -1;
  let footer = -1;
  lines.forEach((line, index) => {
    if (line.trim() === 'Subagents') title = index;
    if (/^\s*Press enter to confirm or esc to go back\s*$/i.test(line)) footer = index;
  });
  if (title < 0 || footer <= title || lines.slice(footer + 1).some(line => line.trim())) return null;
  if (!lines.slice(title + 1, footer).some(line => line.includes('Select an agent to watch.'))) return null;
  const rows: PickerRow[] = [];
  const body = lines.slice(title + 1, footer).join('\n');
  const pattern = new RegExp(`^[ \\t]*(›?)[ \\t]*(\\d+)\\. ([\\s\\S]*?)(?=^[ \\t]*›?[ \\t]*\\d+\\. |$(?![\\s\\S]))`, 'gm');
  for (const match of body.matchAll(pattern)) {
    const ids = match[3].match(new RegExp(UUID, 'gi')) ?? [];
    // A clipped/ambiguous description is never sufficient to select a thread.
    if (ids.length === 1) rows.push({ id: ids[0].toLowerCase(), number: Number(match[2]), selected: match[1] === '›', current: match[3].includes('(current)') });
  }
  return rows;
}

/** Verified against OpenAI Codex rust-v0.154.0:
 * tui/src/app/session_lifecycle.rs builds /subagents UUID rows and current markers;
 * tui/src/bottom_pane/list_selection_view.rs handles arrows, Home, Enter and Escape.
 * The picker is NOT searchable and /subagents does NOT take inline arguments.
 * No live-session inputs are sent until an empty enabled composer or this exact picker is seen.
 */
export async function navigateSession(mainPane: string | null | undefined, id: string, adapter: NavigationAdapter = terminalAdapter): Promise<NavigationResult> {
  const fail = (message: string): NavigationResult => ({ ok: false, message });
  if (!mainPane || !/^%\d+$/.test(mainPane)) return fail('No valid Codex tmux pane is connected.');
  if (!new RegExp(`^${UUID}$`, 'i').test(id)) return fail('The selected agent has no valid session ID.');
  if (activePanes.has(mainPane)) return fail('A thread switch is already in progress.');
  const target = id.toLowerCase();
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
  const closePicker = async () => { if (pickerRows(await read()) !== null) await keys('Escape'); };
  const openPicker = async (): Promise<NavigationPane | null> => {
    const before = await read();
    if (pickerRows(before) !== null) return before;
    if (!isCodex(before) || !emptyComposer(before)) return null;
    await adapter.sendKeys(mainPane, ['/subagents'], true);
    // Codex paste_burst.rs suppresses Enter for 120ms after rapid text input.
    // Let it expire, then verify the composer again before submitting.
    await adapter.wait(150);
    const typed = await waitFor(pane => {
      const line = plain(pane.capture.split('\n')[pane.cursorY] ?? '');
      return /^\s*› \/subagents\s*$/.test(line);
    });
    if (!typed) return null; // Never submit an unexpected composer or clear its contents.
    await keys('Enter');
    return waitFor(pane => pickerRows(pane) !== null);
  };
  try {
    const first = await read();
    if (!isCodex(first)) return fail('The main pane is not an active Codex composer; leave copy mode or other terminal views first.');
    if (pickerRows(first) === null && !emptyComposer(first)) return fail('Codex has a draft or another view open. Keep the draft safe and switch when its composer is empty.');
    let pane = await openPicker();
    if (!pane) return fail('Could not open the verified Codex Subagents picker.');
    const initialRows = pickerRows(pane) ?? [];
    // Start from the current row. Reset only when the target is outside this
    // viewport and a scan is needed; an already-visible target needs no scan.
    if (!initialRows.some(row => row.id === target) && !initialRows.some(row => row.selected && row.number === 1)) {
      await keys('Home');
      pane = await waitFor(value => pickerRows(value)?.some(row => row.selected && row.number === 1) === true);
    }
    const visited = new Set<string>();
    let selected: PickerRow | undefined;
    for (let moves = 0; pane && moves < 100; moves++) {
      selected = pickerRows(pane)?.find(row => row.selected);
      if (!selected) break;
      if (selected.id === target) break;
      const visibleTarget = pickerRows(pane)?.find(row => row.id === target);
      if (visibleTarget) {
        const delta = visibleTarget.number - selected.number;
        if (!delta || Math.abs(delta) > 100) { selected = undefined; break; }
        // One tmux delivery lets Codex coalesce the intermediate row redraws.
        // Recheck the UUID after the batch in case live picker ordering changed.
        await keys(...Array<string>(Math.abs(delta)).fill(delta > 0 ? 'Down' : 'Up'));
        pane = await waitFor(value => pickerRows(value)?.some(row => row.selected && row.id === target) === true);
        selected = pane ? pickerRows(pane)?.find(row => row.selected) : undefined;
        break;
      }
      if (visited.has(selected.id)) { selected = undefined; break; }
      visited.add(selected.id);
      await keys('Down');
      const previous = selected.id;
      pane = await waitFor(value => {
        const rows = pickerRows(value);
        return rows === null || rows.some(row => row.selected && row.id !== previous);
      });
    }
    if (!selected || selected.id !== target) {
      await closePicker();
      return fail('The exact session ID was not found in the visible Codex picker.');
    }
    // Re-read before submitting in case live picker refresh changed the selection.
    const confirmed = pickerRows(await read())?.find(row => row.selected);
    if (confirmed?.id !== target) { await closePicker(); return fail('Codex selection changed; try the thread switch again.'); }
    if (confirmed.current) {
      await closePicker();
      await adapter.focusPane(mainPane);
      return {ok:true,message:'Codex is already showing this thread.',sessionId:target,confirmed:true};
    }
    await keys('Enter');
    const switched = await waitFor(value => pickerRows(value) === null);
    if (!switched) return fail('Codex did not close the picker after the switch request.');
    // Opening /subagents again caused a second popup, redraw and transcript
    // jump. A closed picker acknowledges delivery, not proof of the final view.
    // Preserve any restored target draft and report only what we can observe.
    await adapter.focusPane(mainPane);
    return {ok:true,message:'Codex thread switch requested.',sessionId:target,confirmed:false};
  } catch {
    // Do not send cleanup keys into a pane whose current view cannot be verified.
    return fail('Could not communicate with the Codex tmux pane.');
  } finally { activePanes.delete(mainPane); }
}
