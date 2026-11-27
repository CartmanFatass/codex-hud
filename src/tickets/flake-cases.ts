/** Pure Markdown parsing shared by ticket migration and flake collection. */
export const COMMENTS_HEADING = /^## Comments[ \t]*\r?$/m;
export const CASES_HEADING = /^###[ \t]+Cases[ \t]*\r?$/m;
export const CHECKBOX_LINE = /^[ \t]*[-*] \[[ xX]\]/m;

export interface FlakeCase {
  name: string;
  file?: string;
  flow?: string;
  log?: string;
  unidentified?: boolean;
}

export function isRunningListTicket(text: string): boolean {
  const body = text.split(COMMENTS_HEADING, 1)[0];
  return /\brunning list\b/i.test(body) || /^(?:###[ \t]+Cases|\*\*Kind:\*\*[ \t]*flake-list)[ \t]*\r?$/m.test(body);
}

export function parseFlakeCaseLine(line: string): FlakeCase | null {
  const bullet = /^[ \t]*[-*][ \t]+(.+)$/.exec(line);
  if (!bullet) return null;
  const text = bullet[1].trim();
  const match = / — (?:flow `([^`]+)`(?:,[ \t]+log `([^`]+)`)?|log `([^`]+)`)$/.exec(text);
  const subject = match ? text.slice(0, match.index) : text;
  let name: string | undefined;
  let file: string | undefined;
  let unidentified = false;
  const unidMatch = /^unidentified(?: gate)? failure \(`([^`\r\n]+)`(?:,[ \t]+([^)\r\n]+))?\)$/i.exec(subject);
  if (unidMatch) {
    name = unidMatch[1].trim();
    file = unidMatch[2]?.trim() || undefined;
    unidentified = true;
  } else {
    const named = /^`(.+)`(?: \((.+)\))?$/.exec(subject);
    name = named?.[1].trim();
    file = named?.[2]?.trim();
  }
  if (!name) return null;
  const flow = match?.[1]?.trim(), log = (match?.[2] ?? match?.[3])?.trim();
  return {
    name,
    ...(file ? { file } : {}),
    ...(flow ? { flow } : {}),
    ...(log ? { log } : {}),
    ...(unidentified ? { unidentified: true } : {}),
  };
}

export function parseFlakeCases(text: string): FlakeCase[] {
  const body = text.split(COMMENTS_HEADING, 1)[0];
  const cases: FlakeCase[] = [];
  for (const line of body.split(/\r?\n/)) {
    const parsed = parseFlakeCaseLine(line);
    if (parsed?.flow) cases.push(parsed);
  }
  // Also recognize legacy hand-written running-list prose (`Cases: ...`) before `### Cases` or acceptance items.
  const prosePart = body.split(CASES_HEADING, 1)[0].split(CHECKBOX_LINE, 1)[0];
  const inlineIdx = prosePart.search(/\bCases:/i);
  if (inlineIdx >= 0) {
    const inline = prosePart.slice(inlineIdx + 'Cases:'.length);
    const re = /`([^`\r\n]+)`(?:[ \t]*\(([^()\r\n]+\.(?:[cm]?js|[cm]?ts))\b[^()\r\n]*\))?/g;
    for (const match of inline.matchAll(re)) {
      const name = match[1].trim();
      if (!name) continue;
      cases.push({ name, ...(match[2] ? { file: match[2].trim() } : {}) });
    }
  }
  return cases;
}
