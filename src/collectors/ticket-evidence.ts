/** Shared ticket identity and file evidence. No project scan or Git call. */
export function targetKey(id: string): string {
  const token = id.trim().toLowerCase(), m = /^([a-z0-9]+(?:-[a-z0-9]+)*)[-/#](\d+)$/.exec(token);
  return m ? `${m[1]}/${Number(m[2])}` : token;
}

export function ticketHeading(text: string, number: number) {
  const match = text.match(/^# (\d+):[ \t]*(\S[^\r\n]*)/m);
  return match && Number(match[1]) === number ? { number: match[1], title: match[2].trim() } : null;
}

export function ticketFileEvidence(text: string) {
  const [body, commentsSection = ''] = text.split(/^## Comments[ \t]*\r?$/m, 2);
  const comments = commentsSection.split(/^## /m, 1)[0];
  const field = (key: string) => body.match(new RegExp(`(?:^|·)[ \\t]*\\*\\*${key}:\\*\\*[ \\t]*([^·\\r\\n]*)`, 'mi'))?.[1]?.trim();
  const status = field('Status'), blocked = field('Blocked by');
  const trial = field('Owner try') ?? '';
  const ownerTry = /^yes$/i.test(trial);
  const items = [...body.matchAll(/^[ \t]*[-*] \[([ xX])\][ \t]*([^\r\n]*)/gm)].map(b => ({
    done: b[1].toLowerCase() === 'x', text: b[2].replace(/\s+/g, ' ').trim(),
  }));
  const checked = items.filter(i => i.done).length;
  const record = [...comments.matchAll(/^[ \t]*[-*][ \t]+Landed:?[ \t]+(?:in this commit \(replay base (?:[0-9a-f]{40}|[0-9a-f]{64})\)|(?:(?:in|at)[ \t]+)?`?([0-9a-f]{7,40})`?\b)/gim)].at(-1);
  const commit = record?.[1], recordedLanding = !!record;
  const allChecked = items.length > 0 && checked === items.length;
  const readyForHuman = /^ready-for-human\b/i.test(status ?? '');
  const landed = /^(wontfix|dropped)\b/i.test(status ?? '') ? 'dropped'
    : /^(accepted|done|closed|complete|resolved)\b/i.test(status ?? '') ? 'done'
    // Preserve legacy pending records with no Owner try field.
    : /^try\b/i.test(status ?? '') || recordedLanding || (readyForHuman && allChecked) ? (/^no\b/i.test(trial) ? 'done' : 'try')
    : allChecked ? 'done' : undefined;
  return { status, blocked, items, checked, ownerTry, landed, recordedLanding, ...(commit ? { commit } : {}) } as const;
}
