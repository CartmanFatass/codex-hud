/** Display grammar: «word», «+approval», «-objection», «!opinion». Old plain marks remain valid. */
export function keywordMarks(raw: string) {
  const spans: { start: number; end: number; type: string }[] = [];
  let plain = '', cursor = 0;
  const matches = [...raw.matchAll(/«([+!-]?)([^«»]*)»/g)];
  for (const m of matches) {
    plain += raw.slice(cursor, m.index).replace(/«[+!-]?|»/g, '');
    const start = plain.length;
    plain += m[2];
    spans.push({ start, end: plain.length, type: m[1] });
    cursor = m.index! + m[0].length;
  }
  plain += raw.slice(cursor).replace(/«[+!-]?|»/g, '');
  const valid =
    matches.length <= 4 && matches.every((m) => m[2].trim()) &&
    !/[«»]/.test(raw.replace(/«[+!-]?[^«»]*»/g, ''));
  return { plain, spans: valid ? spans : [], valid };
}
/** Count visible words, not delimiters/prefixes; close any mark crossing the title cap. */
export function markedTitle(text: string, language: string): string {
  const { plain, spans } = keywordMarks(text);
  const words = [...new Intl.Segmenter(language, { granularity: 'word' }).segment(plain)].filter((s) => s.isWordLike);
  const end = words[8]?.index ?? plain.length;
  let title = '', cursor = 0;
  for (const span of spans.slice(0, 2)) {
    if (span.start >= end) break;
    const stop = Math.min(end, span.end);
    title += plain.slice(cursor, span.start) + `«${span.type}${plain.slice(span.start, stop).trimEnd()}»`;
    cursor = stop;
  }
  return (title + plain.slice(cursor, end)).trim();
}
export const keywordPrompt = 'Mark up to 4 keywords: «word», «+approve/accept/agree/pass 批准/同意/通过/接受», «-reject/object/oppose/fail/block 拒绝/反对/驳回/失败/阻塞», «!opinion or recommendation». Use the prefix for its meaning, not as literal wording.';
