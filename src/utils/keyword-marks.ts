/** Only short, balanced, non-nested corner quotes are alternate keyword marks. */
function cornerMarks(raw: string): string {
  let depth = 0, start = 0, cursor = 0, nested = false, text = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '「') {
      if (depth++ === 0) { start = i; nested = false; }
      else nested = true;
    } else if (raw[i] === '」' && depth && --depth === 0) {
      const content = raw.slice(start + 1, i), payload = content.replace(/^[+!-]/, '');
      if (!nested && payload && Array.from(payload).length <= 24 && !/[\s。！？!?，,；;：:]|\.$/.test(payload)) {
        text += raw.slice(cursor, start) + `«${content}»`;
        cursor = i + 1;
      }
    }
  }
  return text + raw.slice(cursor);
}
/** Display grammar: «word», «+approval», «-objection», «!opinion», plus short 「…」 marks. */
export function keywordMarks(raw: string) {
  raw = cornerMarks(raw);
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
export const keywordPrompt = 'Use «…» keyword delimiters in every language, including Simplified Chinese (for example «解析器»); do not use 「…」. Mark up to 4 keywords: «word», «+approve/accept/agree/pass 批准/同意/通过/接受», «-reject/object/oppose/fail/block 拒绝/反对/驳回/失败/阻塞», «!opinion or recommendation». Use the prefix for its meaning, not as literal wording.';
