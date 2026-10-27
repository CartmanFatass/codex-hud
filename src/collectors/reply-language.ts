/**
 * Whether a model's reply is in the language it was asked for.
 *
 * Every request says which language to write in, whatever the material is
 * in, and the panel stores and shows what comes back as written in that
 * language. A model that answers in another one (Japanese for Chinese,
 * Chinese for English) would otherwise be shown as if it had obeyed: Han
 * characters alone cannot tell Chinese from Japanese.
 *
 * Only the words a person reads are judged: a JSON reply's string values,
 * not its keys, with code spans, paths and URLs left out. The test is a
 * share, not a presence, so a reply may quote a name or a short line in
 * another language and still pass:
 *
 * - asked for Chinese: wrong when kana or Hangul make up a fifth of its CJK
 *   characters (Japanese prose runs at well over a third kana), or when it
 *   has a sentence's worth of Latin letters and no Han character at all;
 * - asked for English: wrong when CJK characters make up three tenths of its
 *   letters.
 */
import type { Language } from '../render/i18n.js';

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu;
const KANA_HANGUL = /[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/gu;
const LATIN = /[A-Za-z]/g;

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/** Fields that echo the material's own names back (an agent's name, an id, a path): not the model's words. */
const ECHOED = new Set(['agent', 'id', 'path']);

function strings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) if (!ECHOED.has(key)) strings(item, out);
}

/** The words of a reply a person reads: a JSON reply's string values (fenced or not), else the whole text; code, paths and URLs out. */
export function replyWords(text: string): string {
  let words = text;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  for (const candidate of [text.trim(), start >= 0 && end > start ? text.slice(start, end + 1) : '']) {
    if (!candidate) continue;
    try {
      const found: string[] = [];
      strings(JSON.parse(candidate) as unknown, found);
      words = found.join('\n');
      break;
    } catch { /* Not JSON: the next candidate, or the text as it is. */ }
  }
  return words
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\bhttps?:\/\/\S+/g, ' ')
    .replace(/(?:[\w.-]*\/)+[\w.-]+/g, ' ');
}

/** Whether `text`, a model's reply, is plainly in a language other than `language`. */
export function wrongLanguage(text: string, language: Language): boolean {
  const words = replyWords(text);
  const han = count(words, HAN);
  const other = count(words, KANA_HANGUL);
  const latin = count(words, LATIN);
  if (language === 'zh') return (other >= 4 && other >= 0.2 * (han + other)) || (han === 0 && other === 0 && latin >= 24);
  const cjk = han + other;
  return cjk >= 6 && cjk >= 0.3 * (cjk + latin);
}
