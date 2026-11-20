// Cell-grid toolkit for the model picker sample. Synthetic data only. Run `node gen.mjs` to rebuild ../index.html.
// Copied from docs/design/control-tab/gen/lib.mjs and made width-parameterized: `grid(W)` binds the row helpers to a
// width, because this sample draws 40-column frames (the panel) and 120-column frames (the zoomed panel pane).
//
// A frame is a list of rows; a row is a list of segments {t: text, k: ink[/surface]}, padded to exactly W CELLS.
// A cell is what the terminal paints: CJK is two cells wide, the same ranges src/render/colors.ts `codePointWidth` uses.

// -------------------------------------------------------------------------------------------------------- cell width
const ZERO = [[0x0300, 0x036f], [0x200b, 0x200f], [0x20d0, 0x20f0], [0xfe00, 0xfe0f], [0xfeff, 0xfeff]];
const WIDE = [[0x1100, 0x115f], [0x26a1, 0x26a1], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x2fffd], [0x30000, 0x3fffd]];
export function cw(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 0x0300) return 1;
  if (ZERO.some(([a, b]) => cp >= a && cp <= b)) return 0;
  return WIDE.some(([a, b]) => cp >= a && cp <= b) ? 2 : 1;
}
export const len = (s) => { let n = 0; for (const ch of s) n += cw(ch); return n; };

// {ink text}: ink names are the panel's own words (see the page CSS): t text, m muted, f frame (rules), a attention,
// d danger, s success, b active (blue), o stalled, i identifier, n info. `ink/surface` adds a surface (title, body, sel);
// a trailing * is bold.
const RE = /\{([a-z0-9*/]+) ([^}]*)\}/g;
export function parse(markup) {
  const out = [];
  let last = 0, x;
  RE.lastIndex = 0;
  while ((x = RE.exec(markup))) {
    if (x.index > last) out.push({ t: markup.slice(last, x.index), k: 't' });
    out.push({ t: x[2], k: x[1] });
    last = RE.lastIndex;
  }
  if (last < markup.length) out.push({ t: markup.slice(last), k: 't' });
  return out;
}
export const cells = (segs) => segs.reduce((n, s) => n + len(s.t), 0);
export const plain = (markup) => parse(markup).map((s) => s.t).join('');
export const width = (markup) => cells(parse(markup));
const LENIENT = !!process.env.LENIENT;

/** Cut plain text to n cells with an ellipsis. */
export function cut(s, n) {
  if (len(s) <= n) return s;
  let out = '', used = 0;
  for (const ch of s) { if (used + cw(ch) > n - 1) break; out += ch; used += cw(ch); }
  return out + '…';
}
/** The middle of a long id goes, its head and its tail stay: ids differ at the end. */
export function mid(s, n) {
  if (len(s) <= n) return s;
  const tail = Math.ceil((n - 1) * 0.6), head = n - 1 - tail, chars = [...s];
  let h = '', t = '';
  for (const ch of chars) { if (len(h + ch) > head) break; h += ch; }
  for (const ch of chars.reverse()) { if (len(ch + t) > tail) break; t = ch + t; }
  return h + '…' + t;
}
export const pad = (s, n) => s + ' '.repeat(Math.max(0, n - len(s)));
export const padl = (s, n) => ' '.repeat(Math.max(0, n - len(s))) + s;
/** Markup padded on the right with plain spaces to n cells (cut if wider, in lenient mode only). */
export const padm = (markup, n) => markup + ' '.repeat(Math.max(0, n - width(markup)));
/** Wrap plain text to n cells. A break falls after `/` or `-` inside an id, at a space in prose, anywhere for CJK. */
export function wrap(text, n) {
  const out = [];
  let rest = text;
  while (len(rest) > n) {
    let used = 0, cutAt = 0, soft = -1;
    const chars = [...rest];
    for (let i = 0; i < chars.length; i++) {
      const c = cw(chars[i]);
      if (used + c > n) break;
      used += c; cutAt = i + 1;
      if (chars[i] === ' ' || chars[i] === '/' || chars[i] === '-' || c === 2) soft = i + 1;
    }
    const at = soft > 0 && soft >= cutAt * 0.5 ? soft : cutAt;
    out.push(chars.slice(0, at).join('').trimEnd());
    rest = chars.slice(at).join('').trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/** Segments from markup, every one given a surface (the cursor band on one pane of a row). */
export const band = (segs, surface = 'sel') => segs.map((s) => {
  const [ink, has] = s.k.replace('*', '').split('/');
  return has ? s : { ...s, k: `${ink}/${surface}${s.k.includes('*') ? '*' : ''}` };
});

export function grid(W) {
  const fail = (what, markup, n) => {
    const msg = `${what} (${n} cells > ${W}): ${plain(markup)}`;
    if (!LENIENT) throw new Error(msg);
    console.error('OVER ' + msg);
  };
  /** Lenient mode (a drawing aid): cut the segments to W cells so the dump still shows the row. */
  function clip(segs) {
    const out = []; let used = 0;
    for (const s of segs) {
      let t = '';
      for (const ch of s.t) { if (used + cw(ch) > W) break; t += ch; used += cw(ch); }
      out.push({ ...s, t });
    }
    return out;
  }

  /** One row, padded to W. `bg` is the whole row's surface: title, sel. `item` names the entry the row belongs to. */
  function row(markup = '', bg, item) {
    const segs = parse(markup), n = cells(segs);
    if (n > W) { fail('row too wide', markup, n); return { segs: clip(segs), bg, item }; }
    if (n < W) segs.push({ t: ' '.repeat(W - n), k: 't' });
    return { segs, bg, item };
  }
  /** A row from segments (already parsed, possibly banded), padded to W. */
  function fromSegs(segs, bg, item) {
    const n = cells(segs);
    if (n > W) { fail('row too wide', segs.map((s) => s.t).join(''), n); return { segs: clip(segs), bg, item }; }
    return { segs: n < W ? [...segs, { t: ' '.repeat(W - n), k: 't' }] : segs, bg, item };
  }
  /** Left text and right text on one row, at least one cell apart (monitor-text.ts `pair`). */
  function lr(left, right, bg, item) {
    const L = parse(left), R = parse(right), gap = W - cells(L) - cells(R);
    if (gap < 1) { fail('lr too wide', left + ' | ' + right, cells(L) + cells(R) + 1); return { segs: clip([...L, { t: ' ', k: 't' }, ...R]), bg, item }; }
    return { segs: [...L, { t: ' '.repeat(gap), k: 't' }, ...R], bg, item };
  }
  /** Like `lr`, with the right side chosen from candidates: the first one that leaves a gap of two. */
  function lrFit(left, rights, bg, item) {
    const lw = width(left);
    const r = rights.find((x) => lw + width(x) + 2 <= W) ?? rights[rights.length - 1];
    return lr(left, r, bg, item);
  }
  const blank = () => row('');
  /** `Title ───────── right`, the panel's section row (workboard-rows.ts `section`). */
  function sec(label, right = '', item) {
    const tail = right ? width(right) : 0;
    const rule = Math.max(0, W - width(label) - tail - (tail ? 2 : 1));
    const left = `${label} {f ${'─'.repeat(rule)}}`;
    return right ? lr(left, right, undefined, item) : row(left, undefined, item);
  }
  /** Rows, then the footer on the last one. `h` is the panel's height, or 'auto': as tall as the rows need, one blank row above the footer. */
  function frame(rows, h, footer, name) {
    const body = rows.filter(Boolean);
    if (h === 'auto') h = body.length + 2;
    if (body.length >= h) throw new Error(`${name}: ${body.length} rows + footer do not fit ${h}`);
    while (body.length < h - 1) body.push(blank());
    body.push(footer);
    return { rows: body, h, W, used: rows.filter(Boolean).length };
  }
  /** The footer: an optional left note, then key hints cut from the right until they fit whole (workboard-rows.ts `footHints`). */
  function foot(left, hints) {
    const room = W - width(left) - (left ? 2 : 1), parts = hints.split('  ');
    while (parts.length && len(parts.join('  ')) > room) parts.pop();
    return lr(left, `{m ${parts.join('  ')}}`);
  }
  return { W, row, fromSegs, lr, lrFit, blank, sec, frame, foot };
}
