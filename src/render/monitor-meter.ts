/** The panel's meters: thin lines filled to a reading, on the status card, the cards and the tree. */
import { theme, colors, visualLength, getContextColor, getMeterColor } from './colors.js';
import { palette } from './palette.js';

/** Columns of an agent row's context meter. */
export const CONTEXT_METER_WIDTH = 3;

/**
 * An agent's context fill as a short horizontal line: heavy where used,
 * light where free, with a half step. Block characters fill the whole cell
 * height in many fonts and read as a tile rather than a fill; a line stays
 * a line. Colour follows the same thresholds as the bar's context meter.
 */
export function contextLine(percent: number, cells: number): string {
  const clamped = Math.max(0,Math.min(100,percent));
  const halves = clamped > 0 ? Math.max(1,Math.round(clamped/100*cells*2)) : 0;
  const full = Math.floor(halves/2);
  const half = halves%2 ? '╸' : '';
  const used = '━'.repeat(full)+half;
  return getContextColor(clamped)(used)+colors.dim('─'.repeat(Math.max(0,cells-visualLength(used))));
}

/** Fewest columns of bar a meter keeps beside its reading; under it the tail goes first. */
export const METER_MIN = 4;
/**
 * A meter drawn as a thin line, as omp draws its context meter in the gap
 * of its status band: "────56%──────────────246K". One look for every meter
 * in the panel: the status card's context and quota, the agent cards'
 * bottom rules and the finished agents' rows.
 */
export interface EdgeMeter {
  /** How full, 0–100: the share of the line drawn in the zone colour. */
  percent: number;
  /** The reading at the fill's head, plain: "56%", "44% left". Absent is the percentage. */
  label?: string;
  /** Painted, just before the reading: "~" while it waits on a newer turn. */
  mark?: string;
  /** Plain, closing the line in the tick colour: the window size, "246K". */
  tail?: string;
  /** Where a known threshold sits, 0–100, drawn "┃". Only one the HUD can read, never a guess. */
  tick?: number;
}

/**
 * The meter `cells` wide, exactly: the fill in its zone colour (info, then
 * warning past 70%, danger past 85%), the reading in bold at the fill's head
 * and moving with it, the track in the track colour, then "─" and the tail
 * in the tick colour. Short of room the tail goes, then the bar shrinks to
 * nothing but the reading; under the reading's width it is track alone. With
 * no colour at all (`none`) the fill is heavy and the track light, so the
 * reading still shows how full. `bar` says whether at least `METER_MIN`
 * columns of bar were drawn (`cols` how many), `tail` whether the tail was.
 */
export function meterText(meter: EdgeMeter, cells: number): {text: string; bar: boolean; tail: boolean; cols: number} {
  if (cells <= 0) return {text:'',bar:false,tail:false,cols:0};
  const percent = Math.max(0,Math.min(100,meter.percent));
  const zone = getMeterColor(percent);
  const label = meter.label ?? `${Math.round(meter.percent)}%`;
  const mark = meter.mark ?? '';
  const head = visualLength(mark)+visualLength(label);
  if (cells < head) return {text:theme.track('─'.repeat(cells)),bar:false,tail:false,cols:0};
  const tailCols = meter.tail ? 1+visualLength(meter.tail) : 0;
  const withTail = tailCols > 0 && cells-head-tailCols >= METER_MIN;
  const bar = cells-head-(withTail ? tailCols : 0);
  const full = Math.max(0,Math.min(bar,Math.round(percent/100*bar)));
  const heavy = palette().name === 'none';
  const tick = meter.tick !== undefined && meter.tick > 0 && meter.tick < 100 ? Math.min(bar-1,Math.round(meter.tick/100*bar)) : -1;
  let track = '';
  let run = '';
  for (let i = full; i < bar; i++) {
    if (i === tick) { track += theme.track(run)+theme.tick('┃'); run = ''; }
    else run += '─';
  }
  if (run) track += theme.track(run);
  const fill = full ? zone((heavy ? '━' : '─').repeat(full)) : '';
  const tail = withTail ? theme.track('─')+theme.tick(meter.tail!) : '';
  return {text:fill+mark+theme.bold(zone(label))+track+tail,bar:bar >= METER_MIN,tail:withTail,cols:bar};
}

/**
 * Texts with a meter in the gap between them, `width` wide exactly:
 * `left`, the meter, `right`, each given with whatever spacing it wants.
 * Without a meter the gap is blank. Null when the texts leave no gap, or
 * when the meter's bar would be under `needBar` columns (or `needTail` and
 * its tail would not fit): the caller then tries a shorter set of texts.
 */
export function meterRow(width: number, left: string, right: string, meter?: EdgeMeter, needBar = 0, needTail = false): string | null {
  const room = width-visualLength(left)-visualLength(right);
  if (room < 1) return null;
  if (!meter) return left+' '.repeat(room)+right;
  const drawn = meterText(meter,room);
  if ((needBar && drawn.cols < needBar) || (needTail && meter.tail && !drawn.tail)) return null;
  return left+drawn.text+right;
}
