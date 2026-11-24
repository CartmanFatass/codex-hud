import type { LocalLoad, MemoryUse } from '../collectors/local-load.js';
import { visualLength } from './colors.js';
import { palette } from './palette.js';
import type { ThemeName } from './hud-config.js';

const percent = ({ usedKiB, totalKiB }: MemoryUse) => usedKiB / totalKiB * 100;
const paint = { info: 'info', ok: 'success', branch: 'branch' } as const;
type Part = readonly [text: string, role?: keyof typeof paint];

export function localLoadForms({ cpu, ram, swap }: LocalLoad): Part[][] {
  const parts: Part[] = [];
  if (cpu !== undefined) parts.push([`C${cpu}%`, 'info']);
  if (ram) parts.push([`M${Math.round(percent(ram))}%`, 'ok']);
  const core = parts.length;
  if (swap && percent(swap) >= 10) parts.push([`S${Math.round(percent(swap))}%`, 'branch']);
  const form = (gap: string, limit = parts.length) =>
    parts.slice(0, limit).flatMap<Part>((part, i) => i ? [[gap], part] : [part]);
  return parts.length ? [form('  '), form(' '), form(' ', core)] : [];
}

const render = (form: Part[], theme?: ThemeName) => {
  const inks = palette(theme);
  return form.map(([text, role]) => role ? inks[paint[role]](text) : text).join('');
};

export function formatLocalLoad(load: LocalLoad, theme?: ThemeName): string {
  return render(localLoadForms(load)[0] ?? [], theme);
}

export function fitLocalLoad(load: LocalLoad | undefined, width: number): string | undefined {
  const form = load && localLoadForms(load).find((parts) =>
    parts.length && visualLength(parts.map(([text]) => text).join('')) <= width);
  return form && render(form);
}
