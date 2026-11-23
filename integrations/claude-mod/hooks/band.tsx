import type { EngineInterface, On } from 'claude-code';
import type { Band } from '../types';

// The band is for the owner, not the main session: it shows only what needs the owner now, otherwise nothing.
const BAND = { plugin: 'hud-mod', key: 'band' } as const;
const WORDS = {
  en: { waiting: (n: number) => `${n} waiting for you`, toTry: (n: number) => `${n} to try`, accept: 'Accept all in the panel', toast: 'Needs you' },
  zh: { waiting: (n: number) => `${n} 项等你处理`, toTry: (n: number) => `${n} 待试用`, accept: '在面板中全部验收', toast: '需要你' },
};
const wide = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/;
const cells = (text: string) => [...text].reduce((n, ch) => n + (wide.test(ch) ? 2 : 1), 0);

/** The text within `columns` cells (CJK counts two), an ellipsis where it was cut. */
function fitCells(text: string, columns: number): string {
  if (cells(text) <= columns) return text;
  let out = '', n = 0;
  for (const ch of text) {
    if (n + cells(ch) > columns - 1) break;
    out += ch;
    n += cells(ch);
  }
  return `${out}…`;
}

/** At most two rows: the waiting count with its first item, then the slices to try. None when nothing needs the owner. */
export function bandRows(band: Band | undefined, columns: number): string[] {
  const w = band && (WORDS[band.lang] ?? WORDS.en);
  if (!band || !w) return [];
  return [
    band.waiting > 0 && `? ${w.waiting(band.waiting)}${band.first ? ` · ${band.first}` : ''}`,
    band.accept > 0 && `${w.toTry(band.accept)} · ${w.accept}`,
  ].filter((row): row is string => !!row).map(row => fitCells(row, columns));
}

/** The watch's `band` record: kept in `$.state` for the band to draw, and one toast when something new needs the owner. */
export async function takeBand($: EngineInterface, record: Record<string, unknown>) {
  const { lang, waiting, first, accept, fresh } = record;
  if ((lang !== 'en' && lang !== 'zh') || typeof first !== 'string'
    || !Number.isSafeInteger(waiting) || !Number.isSafeInteger(accept)) return;
  const band: Band = { lang, waiting: waiting as number, first, accept: accept as number };
  await $.state.set(BAND, band).catch(() => {});
  const w = WORDS[lang];
  if (fresh === true) $.ui.toast(`${w.toast}: ${[band.waiting && w.waiting(band.waiting), band.accept && w.toTry(band.accept)].filter(Boolean).join(' · ')}`);
}

export function registerBand(on: On) {
  // Drawn from `$.state` alone, which the read subscribes: a new band redraws it, and no I/O happens here.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const band = (await $.state.get(BAND).catch(() => undefined))?.value;
    const rows = e.props.hasSurvey ? [] : bandRows(band, e.props.bodyColumns);
    if (!rows.length) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    return (
      <Box flexDirection="column">
        {rows.map(row => <Text wrap="truncate-end" maxLines={1} color="warning">{row}</Text>)}
      </Box>
    );
  });
}
