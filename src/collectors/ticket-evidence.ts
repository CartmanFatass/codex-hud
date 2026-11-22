/** Shared by Project's rollup and the narrow, synchronous failed-job lookup. No project scan or Git call. */
export function targetKey(id: string): string {
  const token = id.trim().toLowerCase(), m = /^([a-z0-9]+(?:-[a-z0-9]+)*)[-/#](\d+)$/.exec(token);
  return m ? `${m[1]}/${Number(m[2])}` : token;
}

export function ticketFileEvidence(text: string) {
  const body = text.split(/^## Comments[ \t]*\r?$/m, 1)[0];
  const field = (key: string) => body.match(new RegExp(`(?:^|·)[ \\t]*\\*\\*${key}:\\*\\*[ \\t]*([^·\\r\\n]*)`, 'mi'))?.[1]?.trim();
  const status = field('Status'), blocked = field('Blocked by');
  const items = [...body.matchAll(/^[ \t]*[-*] \[([ xX])\][ \t]*([^\r\n]*)/gm)].map(b => ({
    done: b[1].toLowerCase() === 'x', text: b[2].replace(/\s+/g, ' ').trim(),
  }));
  const checked = items.filter(i => i.done).length;
  const landed = /^(wontfix|dropped)\b/i.test(status ?? '') ? 'dropped'
    : /^(accepted|done|closed|complete|resolved)\b/i.test(status ?? '') || (items.length > 0 && checked === items.length) ? 'done'
    : /^try\b/i.test(status ?? '') ? 'try' : undefined;
  return { status, blocked, items, checked, landed } as const;
}
