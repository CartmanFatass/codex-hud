import type { EngineInterface, On } from 'claude-code';
import type { Band } from '../types';
import { openPanel } from './commands';

// The band is for the owner, not the main session: it shows only what needs the owner now, otherwise nothing.
const BAND = { plugin: 'hud-mod', key: 'band' } as const;
const WORDS = {
  en: { waiting: (n: number) => `${n} waiting for you`, open: 'Open', toast: 'Needs you' },
  zh: { waiting: (n: number) => `${n} 项等你处理`, open: '打开', toast: '需要你' },
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

/** The waiting count and first item, fitted beside the Open button. No row without an explicit waiting item. */
function bandRow(band: Band | undefined, columns: number) {
  if (!band || band.waiting <= 0) return undefined;
  const w = WORDS[band.lang] ?? WORDS.en;
  const text = `? ${w.waiting(band.waiting)}${band.first ? ` · ${band.first}` : ''}`;
  return { text: fitCells(text, Math.max(1, columns - cells(w.open) - 1)), label: w.open };
}

/** The watch's `band` record: kept in `$.state` for the band to draw, and one toast when something new needs the owner. */
export async function takeBand($: EngineInterface, record: Record<string, unknown>) {
  const { lang, waiting, first, fresh } = record;
  if ((lang !== 'en' && lang !== 'zh') || typeof first !== 'string' || !Number.isSafeInteger(waiting)) return;
  const band: Band = { lang, waiting: waiting as number, first };
  await $.state.set(BAND, band).catch(() => {});
  const w = WORDS[lang];
  if (fresh === true && band.waiting > 0) $.ui.toast(`${w.toast}: ${w.waiting(band.waiting)}`);
}

export function registerBand(on: On) {
  // Drawn from `$.state` alone, which the read subscribes: a new band redraws it, and no I/O happens here.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const band = (await $.state.get(BAND).catch(() => undefined))?.value;
    const row = e.props.hasSurvey ? undefined : bandRow(band, e.props.bodyColumns);
    if (!row) return next(e);
    const { Box, Button, Text } = $.ui.resolve(e);
    return (
      <Box>
        <Text wrap="truncate-end" maxLines={1} color="warning">{row.text}{' '}</Text>
        <Button key="open" onPress={async () => $.ui.toast(await openPanel($) ?? 'Run /hud to open the panel')}>{row.label}</Button>
      </Box>
    );
  });
}
