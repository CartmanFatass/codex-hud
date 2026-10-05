/** The panel's text: external strings escaped, then fitted, wrapped and cut to the columns there are. */
import { visualLength, truncateAnsi } from './colors.js';

/** External strings are escaped before width calculation or painting. */
export function monitorText(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ch => {
    const cp = ch.charCodeAt(0);
    return ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t'
      : cp > 255 ? `\\u${cp.toString(16).padStart(4,'0')}` : `\\x${cp.toString(16).padStart(2,'0')}`;
  });
}

/**
 * An agent's own words with the markdown it writes for a chat window taken
 * out, for a card or the Inspector: a link is its text, bold, code and
 * heading marks go, and a full commit hash is cut to the seven characters git shows. The
 * raw text stays the log's and the brief material's. Takes raw text; the
 * result still needs `monitorText`.
 */
export function plainText(text: string): string {
  return text
    .replace(/\[([^\]\n]+)\]\([^)\s]*\)/g,'$1')
    .replace(/\*\*([^*\n]+?)\*\*/g,'$1')
    .replace(/__([^_\n]+?)__/g,'$1')
    .replace(/`+/g,'')
    .replace(/(^|\s)#{1,6}(?=\s)/g,'$1')
    .replace(/\b[0-9a-f]{40}\b/g,hash=>hash.slice(0,7));
}
export function fit(text: string, width: number): string {
  const clipped = truncateAnsi(text, Math.max(0,width));
  return clipped + ' '.repeat(Math.max(0,width-visualLength(clipped)));
}
export function pair(left: string, right: string, width: number): string {
  if (!right) return truncateAnsi(left,width);
  const rightWidth = visualLength(right);
  if (rightWidth >= width) return truncateAnsi(right,width);
  return fit(left,width-rightWidth-1)+' '+right;
}

export function wrapped(text: string, width: number): string[] {
  if (width < 1) return [];
  const lines: string[] = []; let line = '';
  for (const char of monitorText(text)) {
    if (visualLength(line+char) > width && line) { lines.push(line); line=''; }
    line += char;
  }
  lines.push(line);
  return lines.map(s => truncateAnsi(s,width));
}
export function helpLines(text: string, width: number): string[] {
  const lines: string[]=[];let line='';
  for(const word of text.split(/\s+/)){
    if(line&&visualLength(line+' '+word)>width){lines.push(line);line='';}
    if(visualLength(word)>width){if(line)lines.push(line);lines.push(...wrapped(word,width));line='';}
    else line+=(line?' ':'')+word;
  }
  if(line)lines.push(line);
  return lines;
}

/**
 * Wrap prose that may mix Chinese and English, filling each line: a line can
 * break between any two characters of Chinese, as Chinese is set, but not
 * inside a Latin word. A word longer than a line is split anyway. Takes
 * sanitized text.
 */
const graphemes = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined,{granularity:'grapheme'}) : null;
/** What a line may break between: runs of ASCII, spaces, and each character of other text. */
function flowTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const run of text.match(/[\x21-\x7e]+|\s+|[^\s\x21-\x7e]+/gu) ?? []) {
    if (/^[\s\x21-\x7e]/u.test(run)) tokens.push(run);
    else if (graphemes) for (const {segment} of graphemes.segment(run)) tokens.push(segment);
    else tokens.push(...run);
  }
  return tokens;
}
/**
 * Closing punctuation stays with the text before it and opening punctuation
 * with the text after it: a line that starts with "。" or "，", or ends with
 * "「", reads as a stray mark.
 */
const CLOSING = /^[。，、；：！？）」』】》〉〕］｝”’…%,.;:!?)\]}]/u;
const OPENING = /^[「『（《〈【〔［｛“‘]$/u;
export function flowLines(text: string, width: number): string[] {
  if (width < 1) return [];
  const lines: string[] = [];
  // The line's words, each with the space before it: a word moved down takes its space, and loses it there.
  let parts: string[] = [];
  const used = () => visualLength(parts.join(''));
  const add = (piece: string) => { parts.push(parts.length ? piece : piece.trimStart()); };
  const push = () => { lines.push(parts.join('').trimEnd()); parts = []; };
  let space = false;
  for (const token of flowTokens(text)) {
    if (/^\s+$/.test(token)) { space = parts.length > 0; continue; }
    const piece = (space ? ' ' : '')+token;
    space = false;
    if (visualLength(token) > width) {
      [...token].forEach((char,i) => {
        const bit = i ? char : piece.slice(0,piece.length-token.length)+char;
        if (parts.length && used()+visualLength(bit) > width) push();
        add(bit);
      });
      continue;
    }
    if (parts.length && used()+visualLength(piece) > width) {
      let carried: string[] = [];
      const room = (moved: string[]) => visualLength((moved.join('')+piece).trimStart()) <= width;
      if (CLOSING.test(token)) {
        // Down with the mark goes the word before it, and any marks just before that word.
        const take: string[] = [];
        while (parts.length-take.length > 1) {
          take.unshift(parts[parts.length-1-take.length]);
          if (!CLOSING.test(take[0].trimStart())) break;
        }
        if (take.length && !CLOSING.test(take[0].trimStart()) && room(take)) { carried = take; parts.length -= take.length; }
      }
      while (parts.length > 1 && OPENING.test(parts.at(-1)!.trim()) && room([parts.at(-1)!,...carried])) carried.unshift(parts.pop()!);
      push();
      for (const moved of carried) add(moved);
    }
    add(piece);
  }
  if (parts.length) push();
  // A last line of one Chinese character, its closing marks aside, reads as
  // a stray: the character before it comes down with it.
  if (lines.length > 1) {
    const split = (line: string) => graphemes ? [...graphemes.segment(line)].map(part=>part.segment) : [...line];
    const last = split(lines.at(-1)!);
    const before = split(lines.at(-2)!);
    const bare = last.filter(char=>!CLOSING.test(char));
    const lone = (char: string | undefined) => char !== undefined && !/^[\x00-\x7f]/.test(char) && !CLOSING.test(char) && !OPENING.test(char);
    if (bare.length === 1 && lone(bare[0]) && before.length > 2 && lone(before.at(-1)) && visualLength(before.at(-1)!+lines.at(-1)!) <= width) {
      lines[lines.length-1] = before.at(-1)!+lines.at(-1)!;
      lines[lines.length-2] = before.slice(0,-1).join('').trimEnd();
    }
  }
  return lines;
}

/**
 * Cut the middle out of a name that does not fit. Agent names share their
 * beginnings (`b05_result_review`, `b05_result_diagnosis`); the end is what
 * tells them apart. Takes sanitized text with no escapes in it.
 */
export function squeeze(text: string, width: number): string {
  if (visualLength(text) <= width) return text;
  if (width < 4) return truncateAnsi(text,width);
  const chars = [...text];
  let head = '';
  for (const ch of chars) { if (visualLength(head+ch) > Math.ceil((width-1)*0.6)) break; head += ch; }
  let tail = '';
  for (let i = chars.length-1; i >= 0; i--) {
    if (visualLength(head)+1+visualLength(chars[i]+tail) > width) break;
    tail = chars[i]+tail;
  }
  return `${head}…${tail}`;
}

/**
 * One line of a diff, or of a file's text, in rows `width` wide. Tabs are
 * spaces to the next fourth column past the marker. Each row after the
 * first starts two columns in, so the marker column starts only the line's
 * first row, and the first row keeps some of the text, not just the marker
 * and the indentation. Takes raw text.
 */
export function diffRows(line: string, width: number): string[] {
  if (width < 1) return [];
  let expanded = '';
  for (const char of line) expanded += char === '\t' ? ' '.repeat(4-Math.max(0,visualLength(expanded)-1)%4) : char;
  const text = monitorText(expanded);
  return breakRows(text,width,width >= 12 ? '  ' : '',1+Math.max(0,text.slice(1).search(/\S/)));
}

/** A path in rows `width` wide, broken after a slash where it can be, as a folder is a word. Takes raw text. */
export function pathRows(path: string, width: number): string[] {
  return width < 1 ? [] : breakRows(monitorText(path),width,'',0,true);
}

/**
 * Text in rows `width` wide, each after the first starting with `hang`. A
 * row ends after a space or a mark (",;:)]}/.=&|-", and an opening bracket
 * that follows a word, as a call's does), or between two Chinese
 * characters, never inside a word that fits on a row; a word longer than a
 * row is cut. The first row breaks past `from`. A path breaks after its
 * slashes alone. Takes sanitized text.
 */
function breakRows(text: string, width: number, hang: string, from: number, path = false): string[] {
  if (visualLength(text) <= width) return [text];
  const wide = (char: string | undefined) => char !== undefined && visualLength(char) > 1;
  const rows: string[] = [];
  let rest = text;
  while (rest) {
    const room = rows.length ? width-hang.length : width;
    if (visualLength(rest) <= room) { rows.push((rows.length ? hang : '')+rest); break; }
    const chars = [...rest];
    const past = rows.length ? 0 : from;
    let used = 0, at = 0, fits = 0, best = 0;
    for (let k = 0; k < chars.length; k++) {
      const char = chars[k];
      const cols = visualLength(char);
      if (used+cols > room) break;
      used += cols; at += char.length; fits = at;
      const next = chars[k+1];
      const opens = /[([{]/.test(char) && k > 0 && /\S/.test(chars[k-1]);
      const ends = path ? char === '/' : /[\s,;:)\]}/.=&|-]/.test(char) || opens || wide(char) || /\s/.test(next ?? '') || wide(next);
      if (at > past && ends) best = at;
    }
    const cut = best || fits || (chars[0]?.length ?? 1);
    rows.push((rows.length ? hang : '')+rest.slice(0,cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  return rows;
}
