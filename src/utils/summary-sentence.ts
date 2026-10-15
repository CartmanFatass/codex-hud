/** A compact model-written sentence, not a replacement for the full Inspector text. */
export function summarySentence(text: string, maxChars = 160): string {
  const first = text.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '';
  const flat = first.replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)/, '').replace(/\s+/g, ' ').trim();
  // Chinese boundaries do not need a following space. Decimal/version dots do.
  const end = /[。！？]|[.!?](?=\s|$)/.exec(flat);
  const sentence = end ? flat.slice(0, end.index + 1) : flat;
  const chars = Array.from(sentence);
  const cap = Math.max(1, Math.floor(maxChars));
  return chars.length > cap ? `${chars.slice(0, cap - 1).join('')}…` : sentence;
}
