/** Pure parsers for worker report notes (Blockers:, Try:, Assumed:). */

export const declaresNone = (value: string) => /^none\p{P}*$/iu.test(value.trim());

// Match pending-try notes (standalone or followed by detail), never mixed text
// that also names an owner decision.
const pendingTryPhrase =
  '(?:(?:only|just)\\s+)?(?:(?:a|the)\\s+)?(?:pending\\s+)?(?:owner\\s+(?:live\\s+|acceptance\\s+)?|live\\s+|acceptance\\s+)tr(?:y|ies)(?:\\s+(?:is\\s+|are\\s+)?(?:still\\s+)?(?:remain(?:s|ing)?|pending|outstanding|not\\s+(?:run|done)(?:\\s+yet)?|(?:left|yet|still)\\s+to\\s+(?:run|do)|(?:to\\s+be|needs?\\s+to\\s+be)\\s+(?:run|done)))?(?:\\s+(?:by|for)\\s+(?:the\\s+)?owner)?(?:\\s+only)?';

const pendingTryExact = new RegExp(`^${pendingTryPhrase}\\s*[.!]?$`, 'i');
const pendingTryWithDetail = new RegExp(`^${pendingTryPhrase}(?:\\s*(?::|[—–]|\\s+-\\s+)\\s*(.+)|\\s*\\(([^()]+)\\)\\s*[.!]?)$`, 'i');
const detailNamesDecision = /\b(?:decid(?:e[ds]?|ing)|decision|approv(?:e[ds]?|ing|al)|choos(?:e[ds]?|ing)|choice|confirm(?:ation)?|block(?:ed|er|ers|ing)?|escalat(?:e[ds]?|ing|ion)|delet(?:e[ds]?|ing|ion)|remov(?:e[ds]?|ing|al)|docs\/spec\.md|spec(?:ification)?|scope|trade-?off|irreversible|needs?\s+(?:an?\s+)?owner|owner\s+(?:must|needs?|should|to\s+decide)|ask\s+(?:the\\s+)?owner|sign-?off|also|however|except)\b|[?;]/i;

const noneModifier = /^(?:(?:that\s+)?(?:requir(?:e[ds]?|ing)|need(?:s|ed|ing)?)\s+(?:an?\s+)?owner\s+(?:decision|decisions|approval|sign-?off|input|action)(?:\s+(?:before\s+(?:this\s+can\s+)?land(?:ing)?|to\s+land))?|(?:for\s+(?:the\s+)?owner|before\s+(?:this\s+can\s+)?land(?:ing)?|blocking\s+land(?:ing)?))\b/i;
const noOwnerDecisionClause = /^no\s+(?:owner\s+(?:decision|decisions|approval|sign-?off|input|action|blocker|blockers)|blockers?)(?:\s+(?:is\s+|are\s+)?(?:needed|required|pending|before\s+(?:this\s+can\s+)?land(?:ing)?|to\s+land))?\s*[.!]?$/i;

const noteHeaderWithColon = /^([ \t]*)(?:([-*])[ \t]+|(#{1,6})[ \t]+(?:\d+\.[ \t]+)?)?(?:\*\*)?(Blockers|Try)(?:\*\*)?:(?:\*\*)?([^\r\n]*)$/i;
const noteHeadingNoColon = /^([ \t]*)(#{1,6})[ \t]+(?:\d+\.[ \t]+)?(?:\*\*)?(Blockers|Try)(?:\*\*)?[ \t]*$/i;
const knownReportField = /^[ \t]*(?:[-*][ \t]+|#{1,6}[ \t]+(?:\d+\.[ \t]+)?)?(?:\*\*)?(?:Blockers|Try|Removes|Assumed|Todo|Decision|Reason|Answer|Owner approval)(?:\*\*)?:|^[ \t]*#{1,6}[ \t]+(?:\d+\.[ \t]+)?(?:\*\*)?(?:Blockers|Try)(?:\*\*)?[ \t]*$/i;
const markdownHeading = /^[ \t]*#{1,6}[ \t]+/;
const horizontalRule = /^[ \t]*(?:[-*_][ \t]*){3,}$/;
const bulletLine = /^([ \t]*)(?:[-*]|\d+\.)[ \t]+(.*)$/;

function cleanInlineNote(raw: string): string {
  let text = raw.trim();
  if (text.endsWith('**') && ((text.match(/\*\*/g)?.length ?? 0) % 2 === 1)) {
    text = text.slice(0, -2).trimEnd();
  }
  if (text.startsWith('**') && text.endsWith('**') && text.length > 4 && !text.slice(2, -2).includes('**')) {
    text = text.slice(2, -2).trim();
  } else if (text.startsWith('`') && text.endsWith('`') && text.length > 2 && !text.slice(1, -1).includes('`')) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

function isPendingTryNote(text: string): boolean {
  if (pendingTryExact.test(text)) return true;
  const match = pendingTryWithDetail.exec(text);
  if (!match) return false;
  const detail = (match[1] ?? match[2] ?? '').trim();
  return Boolean(detail) && !detailNamesDecision.test(detail);
}

function classifyNoneQualifier(tail: string): { ok: true; tries: string[] } | { ok: false } {
  const parts = tail.split(/\s*;\s*/).map(p => p.trim()).filter(Boolean);
  if (!parts.length) return { ok: false };
  const tries: string[] = [];
  for (const part of parts) {
    if (noOwnerDecisionClause.test(part)) continue;
    if (isPendingTryNote(part)) { tries.push(part); continue; }
    return { ok: false };
  }
  return { ok: true, tries };
}

function classifyBlockerText(text: string): { kind: 'none'; tries: string[] } | { kind: 'try'; text: string } | { kind: 'blocker'; text: string } {
  if (declaresNone(text)) return { kind: 'none', tries: [] };
  if (isPendingTryNote(text)) return { kind: 'try', text };
  if (/^none\b/i.test(text)) {
    let rest = text.slice(4).trim();
    const mod = noneModifier.exec(rest);
    if (mod) {
      rest = rest.slice(mod[0].length).trim();
      if (!rest || /^[.!;]+$/.test(rest)) return { kind: 'none', tries: [] };
    }
    const paren = /^\(([^()]+)\)\s*[.!]?$/.exec(rest);
    if (paren) {
      const qual = classifyNoneQualifier(paren[1].trim());
      if (qual.ok) return { kind: 'none', tries: qual.tries };
    }
    const sep = /^(?:\.\s+|[—–;,:]\s*|-\s+)(.+)$/.exec(rest);
    if (sep) {
      const afterSep = sep[1].trim();
      const innerParen = /^\(([^()]+)\)\s*[.!]?$/.exec(afterSep);
      const qual = classifyNoneQualifier(innerParen ? innerParen[1].trim() : afterSep);
      if (qual.ok) return { kind: 'none', tries: qual.tries };
    }
  }
  return { kind: 'blocker', text };
}

export function extractReportNotes(reportText: string): { blockers: string[]; tries: string[] } {
  const blockers: string[] = [], tries: string[] = [];
  const lines = reportText.split(/\r?\n/);

  const recordEntry = (field: 'blockers' | 'try', raw: string) => {
    const text = cleanInlineNote(raw);
    if (!text) return false;
    if (field === 'try') {
      if (!declaresNone(text)) tries.push(text);
      return true;
    }
    const classified = classifyBlockerText(text);
    if (classified.kind === 'none') tries.push(...classified.tries);
    else if (classified.kind === 'try') tries.push(classified.text);
    else blockers.push(classified.text);
    return true;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const colonMatch = noteHeaderWithColon.exec(line);
    const headingMatch = colonMatch ? null : noteHeadingNoColon.exec(line);
    if (!colonMatch && !headingMatch) continue;

    const indent = (colonMatch?.[1] ?? headingMatch?.[1] ?? '').length;
    const isListHeader = Boolean(colonMatch?.[2]);
    const field = (colonMatch?.[4] ?? headingMatch?.[3] ?? '').toLowerCase() as 'blockers' | 'try';
    const inlineValue = colonMatch ? cleanInlineNote(colonMatch[5]) : '';

    if (inlineValue) {
      recordEntry(field, inlineValue);
      continue;
    }

    const items: string[] = [];
    let sawBullet = false;
    let lastBulletIndent = -1;
    let sawBlank = false;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const next = lines[j];
      if (!next.trim()) {
        if (items.length) sawBlank = true;
        continue;
      }
      if (knownReportField.test(next) || markdownHeading.test(next) || horizontalRule.test(next)) break;

      const bMatch = bulletLine.exec(next);
      if (bMatch) {
        const bIndent = bMatch[1].length;
        const bText = bMatch[2].trim();
        if (isListHeader && bIndent <= indent && /^\*\*[^*]+:\*\*/.test(bText)) break;
        if (sawBlank && !sawBullet) break;
        sawBlank = false;
        sawBullet = true;
        lastBulletIndent = bIndent;
        if (bText) items.push(bText);
        continue;
      }

      if (sawBlank) break;
      const nextIndent = next.match(/^[ \t]*/)![0].length;
      if (sawBullet && nextIndent > lastBulletIndent && items.length) {
        items[items.length - 1] = `${items[items.length - 1]} ${next.trim()}`;
      } else if (!sawBullet) {
        items.push(next.trim());
      } else {
        break;
      }
    }
    i = j - 1;

    let recorded = false;
    for (const item of items) {
      if (recordEntry(field, item)) recorded = true;
    }
    if (field === 'blockers' && !recorded) {
      blockers.push('Blockers: declared without details');
    }
  }
  return { blockers, tries };
}

export function extractAssumedLines(reportText: string): { lines: string[]; scopeAssumptions: string[] } {
  const lines: string[] = [];
  for (const match of reportText.matchAll(/^[ \t]*(?:[-*] |#{1,6} )?(?:\*\*)?Assumed:(?:\*\*)?[ \t]*(.+?)[ \t]*$/gim)) {
    const text = match[1].trim();
    if (text) lines.push(text);
  }
  const scopeAssumptions = lines.filter(line => /\bscope\b/i.test(line));
  return { lines, scopeAssumptions };
}
