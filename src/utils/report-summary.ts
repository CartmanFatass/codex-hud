const listMarker = /^(?:[-+*]|\d+[.)])\s+/;
const rule = /^(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const tableRule = /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?$/;
const atx = /^(#{1,6})(?:\s+|$)/;

function reportLines(text: string) {
  const lines = text.split(/\r?\n/);
  let fence = '';
  return lines.map((raw, i) => {
    const line = raw.trim();
    const marker = /^(`{3,}|~{3,})/.exec(line)?.[0];
    const code = !!fence || !!marker || /^(?: {4}|\t)/.test(raw);
    if (marker) {
      if (!fence) fence = marker;
      else if (marker.startsWith(fence) && line === marker) fence = '';
    }
    const underline =
      !code &&
      !!line &&
      !listMarker.test(line) &&
      !line.startsWith('|') &&
      !rule.test(line) &&
      /^(?:=+|-+)$/.test(lines[i + 1]?.trim() ?? '');
    const heading = code
      ? 0
      : (atx.exec(line)?.[1].length ?? (underline ? (lines[i + 1].trim()[0] === '=' ? 1 : 2) : 0));
    return { raw, line, code, heading };
  });
}

/** The first prose line in the bounded MCP wake excerpt, not a structural Markdown line. */
export function firstReportProse(text: string): string | undefined {
  const lines = reportLines(text);
  let table = false,
    list = false;
  for (const [i, { raw, line, code, heading }] of lines.entries()) {
    if (!line) {
      table = list = false;
      continue;
    }
    if (tableRule.test(lines[i + 1]?.line ?? '')) table = true;
    if (table && line.includes('|')) continue;
    table = false;
    if (listMarker.test(line)) {
      list = true;
      continue;
    }
    if (list && /^\s/.test(raw)) continue;
    list = false;
    const underline = lines[i - 1]?.heading && /^(?:=+|-+)$/.test(line);
    if (!code && !heading && !underline && !rule.test(line) && !tableRule.test(line) && !/^[|>]|^=+$/.test(line))
      return line;
  }
}

export const REPORT_EVIDENCE_BYTES = 4096;
const HEAD_BYTES = 512;
const SECTION_BYTES = 896;
const gap = '\n…\n';
const resultLead =
  /^(?:(?:anything in the brief you did not do|(?:what was )?not (?:done|run|completed)|incomplete|unfinished|blocked|blockers?|failed|failures?|tests?|testing|checks?|validation|open questions?|unresolved|skipped|remaining work)\b|未完成|未执行|受阻|阻塞|失败|测试|验证|待确认|开放问题)/iu;

/** Clip a UTF-8 excerpt without sending a broken character or exceeding its byte budget. */
function clip(text: string, max: number, tail = false): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return text;
  let cut = tail ? bytes.length - max : max;
  while ((bytes[cut] & 0xc0) === 0x80) cut += tail ? 1 : -1;
  return (tail ? bytes.subarray(cut) : bytes.subarray(0, cut)).toString('utf8');
}

function resultSections(text: string): string[] {
  const sections: string[] = [];
  let lines: string[] = [],
    level = 0,
    lead = false;
  const flush = () => {
    if (lines.length) sections.push(lines.join('\n').trim());
    lines = [];
  };
  const source = reportLines(text);
  for (const [i, { raw, line, code, heading }] of source.entries()) {
    const label = line
      .replace(atx, '')
      .replace(listMarker, '')
      .replace(/^\[[ xX]\]\s+/, '')
      .replace(/^[*_]+/, '');
    const result = !code && resultLead.test(label);
    if (heading) {
      flush();
      if (heading <= level) level = 0;
      if (result && !level) level = heading;
      lead = false;
    } else if (result || (!line && lead && !level && !/^(?:\s|[-+*]\s)/.test(source[i + 1]?.raw ?? ''))) {
      flush();
      lead = result;
    }
    if (level || lead) lines.push(raw);
  }
  flush();
  return sections;
}

/** Shared, deterministic report input for the sentence and independent outcome models. */
export function reportEvidence(text: string, tail = ''): string {
  text = text.replace(/\r\n/g, '\n');
  const head = clip(text.split('\n', 4).join('\n'), HEAD_BYTES).trimEnd();
  let budget = REPORT_EVIDENCE_BYTES - Buffer.byteLength(head);
  const sections = [...resultSections(text), ...resultSections(tail)];
  if (!sections.length) {
    const rest = tail || text.slice(head.length);
    const end = clip(rest.trim(), budget - Buffer.byteLength(gap), true).trimStart();
    return end ? [head, end].filter(Boolean).join(gap) : head;
  }
  const selected: string[] = [];
  for (const section of sections.reverse()) {
    if (!section || head.includes(section)) continue;
    const max = Math.min(SECTION_BYTES, budget - Buffer.byteLength(gap));
    if (max <= Buffer.byteLength(gap)) break;
    const excerpt =
      Buffer.byteLength(section) <= max
        ? section
        : clip(section, Math.floor((max - Buffer.byteLength(gap)) / 2)).trimEnd() +
          gap +
          clip(section, Math.ceil((max - Buffer.byteLength(gap)) / 2), true).trimStart();
    selected.unshift(excerpt);
    budget -= Buffer.byteLength(excerpt + gap);
  }
  return [head, ...selected].filter(Boolean).join(gap);
}
