/** Pure parsers for worker report notes (Blockers:, Try:, Assumed:). */

export const declaresNone = (value: string) => /^none\p{P}*$/iu.test(value.trim());

// Match pending-try notes only affirmatively: standalone pending-try phrase or
// followed by a single plain try instruction (reopen/run/check/look at ... [and observe]).
const pendingTryPhrase =
  '(?:(?:only|just)\\s+)?(?:(?:a|the)\\s+)?(?:pending\\s+)?(?:owner\\s+(?:live\\s+|acceptance\\s+)?|live\\s+|acceptance\\s+)tr(?:y|ies)(?:\\s+(?:is\\s+|are\\s+)?(?:still\\s+)?(?:remain(?:s|ing)?|pending|outstanding|not\\s+(?:run|done)(?:\\s+yet)?|(?:left|yet|still)\\s+to\\s+(?:run|do)|(?:to\\s+be|needs?\\s+to\\s+be)\\s+(?:run|done)))?(?:\\s+(?:by|for)\\s+(?:the\\s+)?owner)?(?:\\s+only)?';

const pendingTryExact = new RegExp(`^${pendingTryPhrase}\\s*[.!]?$`, 'i');
const pendingTryWithDetail = new RegExp(`^${pendingTryPhrase}(?:\\s*(?::|[—–]|\\s+-\\s+)\\s*(.+)|\\s*\\(([^()]+)\\)\\s*[.!]?)$`, 'i');
const tryActionVerb = /^(?:reopen|open|run|re-?run|launch|start|restart|check|look\s+at|inspect|view|watch|observe)\s+(.+)$/i;
const plainObserveTail = /^(.*?)\s+and\s+(?:(?:observe|watch)(?:\s+(.+))?|(?:inspect|view|look\s+at)\s+(.+))$/i;
const plainTryToken = /^(?:`[./~-]*[a-z0-9](?:[a-z0-9_./-]*[a-z0-9])?`|[./~-]*[a-z0-9](?:[a-z0-9_./-]*[a-z0-9])?)$/i;
const plainTryLocPrep = /^(?:in|on|at|under)$/i;
const plainTryClauseWord = /^(?:and|or|but|nor|yet|so|then|also|plus|however|otherwise|instead|except|vs|versus|if|whether|that|which|who|whom|whose|what|where|when|why|how|unless|until|while|whereas|although|though|because|since|before|after|to|with|for|about|of|by|from|into|over|through|against|between|during|without|should|must|shall|would|could|might|may|need|needs|needed|want|wants|wanted)$/i;

const noneModifier = /^(?:(?:that\s+)?(?:requir(?:e[ds]?|ing)|need(?:s|ed|ing)?)\s+(?:an?\s+)?owner\s+(?:decision|decisions|approval|sign-?off|input|action)(?:\s+(?:before\s+(?:this\s+can\s+)?land(?:ing)?|to\s+land))?|(?:for\s+(?:the\s+)?owner|before\s+(?:this\s+can\s+)?land(?:ing)?|blocking\s+land(?:ing)?))\b/i;
const noOwnerDecisionClause = /^no\s+(?:owner\s+(?:decision|decisions|approval|sign-?off|input|action|blocker|blockers)|blockers?)(?:\s+(?:is\s+|are\s+)?(?:needed|required|pending|before\s+(?:this\s+can\s+)?land(?:ing)?|to\s+land))?\s*[.!]?$/i;

export const REPORT_MARKDOWN_HEADING_PREFIX = '#{1,6}[ \\t]+(?:\\d+\\.[ \\t]+)?';

const noteHeaderWithColon = new RegExp(
  `^([ \\t]*)(?:([-*])[ \\t]+|(${REPORT_MARKDOWN_HEADING_PREFIX}))?(?:\\*\\*)?(Blockers|Try)(?:\\*\\*)?:(?:\\*\\*)?([^\\r\\n]*)$`,
  'i',
);
const noteHeadingNoColon = new RegExp(
  `^([ \\t]*)(${REPORT_MARKDOWN_HEADING_PREFIX})(?:\\*\\*)?(Blockers|Try)(?:\\*\\*)?[ \\t]*$`,
  'i',
);
const knownReportField = new RegExp(
  `^[ \\t]*(?:[-*][ \\t]+|${REPORT_MARKDOWN_HEADING_PREFIX})?(?:\\*\\*)?(?:Blockers|Try|Removes|Assumed|Todo|Decision|Reason|Answer|Owner approval)(?:\\*\\*)?:|^[ \\t]*${REPORT_MARKDOWN_HEADING_PREFIX}(?:\\*\\*)?(?:Blockers|Try)(?:\\*\\*)?[ \\t]*$`,
  'i',
);
const inlineFieldStop = new RegExp(
  `^[ \\t]*(?:[-*][ \\t]+|${REPORT_MARKDOWN_HEADING_PREFIX})?(?:\\*\\*)?(?:Verdict|Summary|Checks|Files|Tests|Preview|Status|Open questions)(?:\\*\\*)?:|^[ \\t]*\\*\\*[^*]+:\\*\\*|^[ \\t]*(?:\`\`\`|~~~|>)`,
  'i',
);
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

function isPlainTryPhrase(phrase: string, maxTokens = 8): boolean {
  const tokens = phrase.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.length > maxTokens) return false;
  if (plainTryLocPrep.test(tokens[0])) return false;
  let seenPrep = false;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!plainTryToken.test(tok)) return false;
    if (plainTryLocPrep.test(tok)) {
      if (seenPrep || i === tokens.length - 1) return false;
      seenPrep = true;
      continue;
    }
    if (plainTryClauseWord.test(tok)) return false;
  }
  return true;
}

function isPlainTryDetail(rawDetail: string): boolean {
  const detail = rawDetail.trim().replace(/\.$/, '').trim();
  const action = tryActionVerb.exec(detail);
  if (!action) return false;
  const rest = action[1].trim();
  const withObserve = plainObserveTail.exec(rest);
  if (withObserve) {
    const target = withObserve[1].trim();
    const observed = (withObserve[2] ?? withObserve[3] ?? '').trim();
    return isPlainTryPhrase(target) && (!observed || isPlainTryPhrase(observed));
  }
  return isPlainTryPhrase(rest);
}

function isPendingTryNote(text: string): boolean {
  if (pendingTryExact.test(text)) return true;
  const match = pendingTryWithDetail.exec(text);
  if (!match) return false;
  const detail = (match[1] ?? match[2] ?? '').trim();
  return Boolean(detail) && isPlainTryDetail(detail);
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
    const inlineValue = colonMatch?.[5].trim() ?? '';

    if (cleanInlineNote(inlineValue)) {
      const parts = [inlineValue];
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        const nextIndent = next.match(/^[ \t]*/)![0].length;
        if (!next.trim() || (isListHeader && nextIndent < indent) ||
            knownReportField.test(next) || inlineFieldStop.test(next) ||
            markdownHeading.test(next) || horizontalRule.test(next) || bulletLine.test(next)) break;
        parts.push(next.trim());
        i++;
      }
      recordEntry(field, parts.join(' '));

      const childItems: string[] = [];
      let lastChildIndent = -1;
      let sawBlank = false;
      let lastConsumed = i;
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (!next.trim()) {
          sawBlank = true;
          continue;
        }
        if (knownReportField.test(next) || markdownHeading.test(next) || horizontalRule.test(next)) break;
        const bMatch = bulletLine.exec(next);
        if (bMatch) {
          const bIndent = bMatch[1].length;
          if (bIndent <= indent) break;
          sawBlank = false;
          lastChildIndent = bIndent;
          const bText = bMatch[2].trim();
          if (bText) childItems.push(bText);
          lastConsumed = j;
          continue;
        }
        if (sawBlank || !childItems.length) break;
        const nextIndent = next.match(/^[ \t]*/)![0].length;
        if (nextIndent >= lastChildIndent && !inlineFieldStop.test(next)) {
          childItems[childItems.length - 1] = `${childItems[childItems.length - 1]} ${next.trim()}`;
          lastConsumed = j;
        } else {
          break;
        }
      }
      i = lastConsumed;
      for (const item of childItems) recordEntry(field, item);
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
      if (sawBullet && nextIndent >= lastBulletIndent && !inlineFieldStop.test(next) && items.length) {
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
