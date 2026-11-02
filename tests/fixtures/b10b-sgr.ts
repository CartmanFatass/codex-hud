/**
 * A tiny SGR reader for the tests: each printable character of an ANSI string
 * with the attributes in force where it is drawn, so a test can say "every cell
 * of this row sits on the band" or "this word is bold" without matching escape
 * sequences by hand.
 */

export interface Cell {
  ch: string;
  bold: boolean;
  faint: boolean;
  fg: string | null;
  bg: string | null;
}

// eslint-disable-next-line no-control-regex
const TOKEN = /\x1b\[([0-9;]*)m|([^\x1b])/gu;

export function cells(ansi: string): Cell[] {
  const out: Cell[] = [];
  let bold = false;
  let faint = false;
  let fg: string | null = null;
  let bg: string | null = null;
  for (const match of ansi.matchAll(TOKEN)) {
    if (match[2] !== undefined) {
      out.push({ ch: match[2], bold, faint, fg, bg });
      continue;
    }
    const params = (match[1] ?? '').split(';').filter((p) => p !== '');
    if (params.length === 0) params.push('0');
    for (let i = 0; i < params.length; i++) {
      const code = Number(params[i]);
      if (code === 0) {
        bold = false;
        faint = false;
        fg = null;
        bg = null;
      } else if (code === 1) bold = true;
      else if (code === 2) faint = true;
      else if (code === 22) {
        bold = false;
        faint = false;
      } else if (code === 38 || code === 48) {
        const mode = params[i + 1];
        const length = mode === '2' ? 3 : 1;
        const value = params.slice(i + 1, i + 2 + length).join(';');
        if (code === 38) fg = value;
        else bg = value;
        i += 1 + length;
      } else if (code === 39) fg = null;
      else if (code === 49) bg = null;
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) fg = String(code);
      else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) bg = String(code);
    }
  }
  return out;
}

/** The cells of the characters of `fragment` where it first occurs in the row's text (by code point). */
export function cellsOf(ansi: string, fragment: string): Cell[] {
  const all = cells(ansi);
  const wanted = [...fragment];
  for (let at = 0; at + wanted.length <= all.length; at++)
    if (wanted.every((ch, i) => all[at + i].ch === ch)) return all.slice(at, at + wanted.length);
  throw new Error(`"${fragment}" is not in "${all.map((c) => c.ch).join('')}"`);
}
