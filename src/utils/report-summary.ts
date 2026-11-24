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

export const reportReadHint = (job: string) => `hud_read job=${job} (mode: "full" for the whole report)`;
