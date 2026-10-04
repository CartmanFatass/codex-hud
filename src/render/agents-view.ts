/**
 * The agents view as one scrolling viewport: the summary line pinned at the
 * top, the rest (cards, or the tree, brief and log) scrolling under it, and a
 * line saying what is out of view. Pure: it writes into the frame it is given.
 */
import type { MonitorFrame, MonitorState, MonitorRow } from './monitor.js';
import { fit } from './monitor.js';
import { colors } from './colors.js';
import { t } from './i18n.js';

/** Rows one wheel step scrolls the agents view. */
export const WHEEL_ROWS = 3;

/**
 * Draw the agents view at `y`, `height` rows tall: the summary line stays
 * put and the rest scrolls under it. When it does not all fit, the last row
 * says how much is out of view, and is a click target that scrolls on.
 *
 * Where it is scrolled to is kept by block, not by row (`anchor`): content
 * arriving above what the reader is looking at does not move it. The view
 * follows the selection only when the selection moves.
 */
export function drawAgentsView(frame: MonitorFrame, state: MonitorState, rows: MonitorRow[], y: number, width: number, height: number): void {
  const pinned = Math.min(1,height,rows.length);
  const room = height-pinned;
  const body = Math.max(0,rows.length-pinned);
  const overflow = room >= 2 && body > room;
  const shown = overflow ? room-1 : room;
  const max = Math.max(0,body-shown);
  let offset = state.scroll.agents;
  const first = (key: string) => rows.findIndex((row,i)=>i>=pinned&&row.key===key);
  if (offset > 0 && state.anchor && state.anchor.offset === offset) {
    const at = first(state.anchor.key);
    if (at >= 0) offset = at+state.anchor.delta-pinned;
  }
  offset = Math.max(0,Math.min(offset,max));
  const selected = state.tree.selectedId;
  if (selected && selected !== state.revealed && shown > 0) {
    const from = rows.findIndex((row,i)=>i>=pinned&&row.item===selected);
    if (from >= 0) {
      let to = from; while (to+1 < rows.length && rows[to+1].item === selected) to++;
      // The whole card when it fits, else its top.
      if (from-pinned < offset) offset = from-pinned;
      else if (to-pinned >= offset+shown) offset = Math.min(from-pinned,to-pinned-shown+1);
      offset = Math.max(0,Math.min(offset,max));
      state.revealed = selected;
    }
  }
  state.scroll.agents = offset;
  // The block the top row belongs to, to find it again by.
  const top = pinned+offset;
  const keyed = rows.findIndex((row,i)=>i>=top&&row.key!==undefined);
  state.anchor = keyed >= 0 ? {key:rows[keyed].key!,delta:top-first(rows[keyed].key!),offset} : undefined;
  frame.panes.push({id:'agents',x:0,y,width,height,rows,offset,contentLength:rows.length,edge:0,pinned,visible:pinned+shown});
  for (let i = 0; i < pinned+shown; i++) {
    const row = i < pinned ? rows[i] : rows[offset+i];
    if (!row) continue;
    frame.lines[y+i] = fit(row.text,width);
    for (const control of row.controls ?? []) if (control.width > 0 && control.x < width) frame.controls.push({...control,x:Math.min(width-1,control.x),y:y+i,width:Math.max(1,Math.min(control.width,width-control.x))});
  }
  if (overflow) {
    const above = offset;
    const below = body-offset-shown;
    const text = below ? (above ? t('↑ {a}  ↓ {n} more lines',{a:above,n:below}) : t('↓ {n} more lines',{n:below})) : t('↑ {n} more lines',{n:above});
    frame.lines[y+height-1] = colors.dim(fit(text,width));
    frame.controls.push({kind:'more',x:0,y:y+height-1,width});
  }
}

