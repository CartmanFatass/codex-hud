/** Small deterministic local grammars. Never a model input or an execution adapter. */
import { createHash } from 'node:crypto';
import type { DecisionRecord, EvidenceRef } from './workboard-types.js';
export const revisionOf = (text: string): string => createHash('sha256').update(text).digest('hex');
const clip = (text: string): string => text.trim().replace(/\s+/g, ' ');
const prose = (text: string): string =>
  text
    .split(/\r?\n\s*\r?\n/)
    .find((p) => p.trim() && !/^\s*(?:#|>|```|One-way:)/i.test(p))
    ?.trim() ?? '';
/** Do not treat quoted choices or negations as an option selection. */
const normalize = (text: string): string =>
  text
    .trim()
    .replace(/^[([\s]+|[)\].,;:\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
const explicitOption = (value: string, options: readonly string[]): number | null => {
  if (/^[\s"'“‘`>]|^not\b/i.test(value) || /\n\s*\n/.test(value.trim())) return null;
  const n = normalize(value);
  const matches = options.flatMap((option, i) => {
    const token = option.match(/^([A-Za-z]|[1-9][0-9]?)\s*[).:\-]\s+(.+)$/);
    if (n === normalize(option) || (token && n === normalize(token[2]))) return [i];
    // A complete leading token, optionally followed by its exact option text. Not arbitrary prose.
    if (token && (n === token[1].toLowerCase() || n === normalize(`${token[1]}) ${token[2]}`))) return [i];
    return [];
  });
  return matches.length === 1 ? matches[0] : null;
};
export function differentExplicitOption(answer: string, suggested: string, options: readonly string[]): boolean {
  if (normalize(answer) === normalize(suggested)) return false;
  const a = explicitOption(answer.trim(), options),
    d = explicitOption(suggested.trim(), options);
  return a !== null && d !== null && a !== d;
}
export interface QuestionFields {
  question: string;
  options: readonly string[];
  suggested: string;
  context?: string;
}
export function questionFields(text: string): QuestionFields {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const optionStart = lines.findIndex((l) => /^Options:\s*$/.test(l));
  const label = (name: string) => text.match(new RegExp(`^${name}:\\s*(.*)$`, 'm'))?.[1]?.trim() ?? '';
  const options: string[] = [];
  // Same grammar, one pass: readable unanswered QA also uses this bounded-file parser.
  if (optionStart >= 0)
    for (const raw of lines.slice(optionStart + 1)) {
      const line = raw.replace(/^\s*[-*]\s+/, '');
      if (/^Default if unanswered:|^Context:|^Answer:/.test(line)) break;
      if (line.trim()) options.push(line);
    }
  return {
    question: clip(prose((optionStart < 0 ? text : lines.slice(0, optionStart).join('\n')).replace(/^#.*\n/, ''))),
    options,
    suggested: label('Default if unanswered'),
    ...(label('Context') ? { context: clip(label('Context')) } : {}),
  };
}
const declaredLines = (text: string): string => {
  let fenced = false;
  return text
    .split(/\r?\n/)
    .filter((line) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        return false;
      }
      return !fenced && !/^\s*>/.test(line);
    })
    .join('\n');
};
const oneWay = (text: string) => /^One-way:\s*true\s*$/im.test(declaredLines(text));
export function answerRecord(
  laneId: string,
  name: string,
  question: string,
  answer: string,
  q: EvidenceRef,
  a: EvidenceRef
): DecisionRecord | null {
  const title = prose(answer);
  if (!title || q.at === null || a.at === null || a.at < q.at) return null;
  const fields = questionFields(question);
  const departure = differentExplicitOption(title, fields.suggested, fields.options);
  const chosen = explicitOption(title.trim(), fields.options);
  const option =
    chosen === null ? null : fields.options[chosen].replace(/^([A-Za-z]|[1-9][0-9]?)\s*[).:\-]\s+/, '$1: ');
  const context = clip([fields.question, fields.context].filter(Boolean).join(' — '));
  const rationale = declaredLines(answer).match(/^(?:Rationale|Why):\s*(.+)$/im)?.[1];
  const explicitInstead = declaredLines(answer).match(/^(?:Instead|Alternative):\s*(.+)$/im)?.[1];
  return {
    id: `${laneId}:qa:${name}`,
    laneId,
    kind: 'answer',
    title: clip(title),
    ...(fields.question ? { question: fields.question } : {}),
    ...(option ? { option: clip(option) } : {}),
    departure,
    oneWay: oneWay(answer),
    ...(departure ? { instead: clip(fields.suggested) } : explicitInstead ? { instead: clip(explicitInstead) } : {}),
    ...(context ? { context } : {}),
    ...(rationale ? { rationale: clip(rationale) } : {}),
    stale: false,
    evidence: [q, a],
  };
}
export function reviewVerdict(text: string): 'accept' | 'changes-required' | null {
  const line = text.split('\n', 1)[0].replace(/\r$/, '');
  return line === 'Verdict: accept' ? 'accept' : line === 'Verdict: changes-required' ? 'changes-required' : null;
}
/** Explicit reported facts only; no rerun aggregation or inferred pass count. */
export function reportedWorkFacts(text: string): {
  tests: number | null;
  passed: number | null;
  failed: number | null;
  files: number | null;
} {
  const taps = [
    ...text.matchAll(/(?:^|\n)# tests (\d+)\r?\n# suites \d+\r?\n# pass (\d+)\r?\n# fail (\d+)(?=\r?\n|$)/g),
  ];
  const tap = taps.length === 1 && taps[0].slice(1).every((n) => Number.isSafeInteger(Number(n))) ? taps[0] : null;
  const section = text.match(/(?:^|\n)#{1,6} (?:Files changed|Changed files)\s*\r?\n([\s\S]*?)(?=\n#{1,6} |$)/i)?.[1];
  const paths = section
    ?.split(/\r?\n/)
    .flatMap((line) => /^[-*] [`]?([^`\s]+)[`]?(?:\s|$)/.exec(line)?.slice(1, 2) ?? []);
  return {
    tests: tap ? Number(tap[1]) : null,
    passed: tap ? Number(tap[2]) : null,
    failed: tap ? Number(tap[3]) : null,
    files: paths?.length && !/\btruncat|\.\.\.|…/.test(section!) ? new Set(paths).size : null,
  };
}
export function reviewRecord(
  laneId: string,
  round: number,
  text: string,
  evidence: EvidenceRef
): DecisionRecord | null {
  const verdict = reviewVerdict(text);
  return verdict
    ? {
        id: `${laneId}:review:${evidence.relativePath}`,
        laneId,
        kind: 'review',
        title: verdict,
        round,
        verdict,
        departure: false,
        oneWay: false,
        stale: false,
        evidence: [evidence],
      }
    : null;
}
/** Only explicit sections; code blocks and quoted historical notes never become calls. */
export function designRecords(laneId: string, text: string, evidence: EvidenceRef): DecisionRecord[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const sections: { key: string; body: string[] }[] = [];
  let active: { key: string; body: string[] } | null = null,
    code = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      code = !code;
      continue;
    }
    if (code || /^\s*>/.test(line)) continue;
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      active =
        /^(?:(?:\d+[.)]?|[A-Z][.)])\s+)?(?:recommendation|recommendations|decision|decisions)(?:\s*[:—-].*)?$/i.test(
          heading[1]
        )
          ? { key: `section-${sections.length}`, body: [] }
          : null;
      if (active) sections.push(active);
    } else if (active) active.body.push(line);
    else if (!sections.length && /^(?:\*\*)?Recommendation:\*\*?\s*\S|^Recommendation:\s*\S/i.test(line)) {
      sections.push({ key: 'recommendation', body: [line.replace(/^(?:\*\*)?Recommendation:(?:\*\*)?\s*/i, '')] });
    }
  }
  return sections.slice(0, 12).flatMap((section) => {
    const body = section.body.join('\n');
    const title = prose(body.replace(/^(?:Instead|Alternative|Rationale|Why|One-way):.*$/gim, ''));
    if (!title) return [];
    const field = (name: string) => body.match(new RegExp(`^(?:${name}):\\s*(.+)$`, 'im'))?.[1];
    const instead = field('Instead|Alternative'),
      rationale = field('Rationale|Why');
    return [
      {
        id: `${laneId}:${evidence.relativePath}:${section.key}`,
        laneId,
        kind: 'recommendation' as const,
        title: clip(title),
        departure: false,
        oneWay: oneWay(body),
        ...(instead ? { instead: clip(instead) } : {}),
        ...(rationale ? { rationale: clip(rationale) } : {}),
        stale: false,
        evidence: [{ ...evidence, section: section.key }],
      },
    ];
  });
}
