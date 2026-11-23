import type { LocalLoad, MemoryUse } from '../collectors/local-load.js';
import { visualLength } from './colors.js';

const gib = (kib: number) => (Math.round(kib / 2 ** 20 * 10) / 10).toFixed(1);
const memory = ({ usedKiB, totalKiB }: MemoryUse) => `${gib(usedKiB)}/${gib(totalKiB)} GiB`;

export function formatLocalLoad({ scope, cpu, ram, swap }: LocalLoad, showSwap = true): string {
  return `${scope}: ${[
    cpu === undefined ? '' : `CPU ${cpu}%`,
    ram ? `RAM ${memory(ram)}` : '',
    showSwap && swap ? `swap ${memory(swap)}` : '',
  ].filter(Boolean).join(' ')}`;
}

export function localLoadForms(load: LocalLoad): string[] {
  return load.swap ? [formatLocalLoad(load), formatLocalLoad(load, false)] : [formatLocalLoad(load)];
}

export function fitLocalLoad(load: LocalLoad | undefined, width: number): string | undefined {
  return load && localLoadForms(load).find((form) => visualLength(form) <= width);
}
