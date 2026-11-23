import type { EngineInterface, On } from 'claude-code';
import type { Band } from '../types';
import { act, openPanel } from './commands';

// The band is for the owner, not the main session: it shows only what needs the owner now, otherwise nothing.
const BAND = { plugin: 'hud-mod', key: 'band' } as const;
const WORDS = {
  en: { waiting: (n: number) => `${n} waiting for you`, toTry: (n: number) => `${n} to try`, open: 'Open', accept: 'Accept all', toast: 'Needs you' },
  zh: { waiting: (n: number) => `${n} 项等你处理`, toTry: (n: number) => `${n} 待试用`, open: '打开', accept: '全部验收', toast: '需要你' },
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

/** At most two rows, each its text and the button that acts on it: the waiting count with its first item (Open the panel), then the slices to try (Accept all). None when nothing needs the owner. */
export function bandRows(band: Band | undefined, columns: number): { key: 'open' | 'accept'; text: string; label: string }[] {
  const w = band && (WORDS[band.lang] ?? WORDS.en);
  if (!band || !w) return [];
  return [
    band.waiting > 0 && { key: 'open' as const, text: `? ${w.waiting(band.waiting)}${band.first ? ` · ${band.first}` : ''}`, label: w.open },
    band.accept > 0 && { key: 'accept' as const, text: w.toTry(band.accept), label: w.accept },
  ].filter(row => !!row).map(row => ({ ...row, text: fitCells(row.text, Math.max(1, columns - cells(row.label) - 1)) }));
}

/** A press: Accept all records the acceptance (the panel's action), Open shows the panel; the result is a toast, never a model turn. */
async function press($: EngineInterface, key: 'open' | 'accept') {
  $.ui.toast(key === 'accept' ? await act($, 'try') : await openPanel($) ?? 'Run /hud to open the panel');
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
    const { Box, Button, Text } = $.ui.resolve(e);
    return (
      <Box flexDirection="column">
        {rows.map(row => (
          <Box key={row.key}>
            <Text wrap="truncate-end" maxLines={1} color="warning">{row.text}{' '}</Text>
            <Button key={row.key} variant={row.key === 'accept' ? 'primary' : undefined} onPress={() => press($, row.key)}>{row.label}</Button>
          </Box>
        ))}
      </Box>
    );
  });
}
