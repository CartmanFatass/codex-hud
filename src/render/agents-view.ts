/**
 * The agents view as one scrolling viewport: its title, with the summary's
 * counts, pinned at the top, the rest (cards, or the tree, brief and log)
 * scrolling under it. Pure: it writes into the frame it is given.
 */
import type { MonitorFrame, MonitorState, MonitorRow } from './monitor.js';
import { fit } from './monitor.js';

/** Rows one wheel step scrolls the agents view. */
export const WHEEL_ROWS = 3;

/**
 * Draw the agents view at `y`, `height` rows tall: its title stays put, as
 * `head` draws it from the summary line's counts (with their words, then
 * without), and the rest scrolls under
 * it. When it does not all fit, the title's right end says which rows are in
 * view ("4–19/46"); a click on the title zooms the view, or restores it.
 *
 * Where it is scrolled to is kept by block, not by row (`anchor`): content
 * arriving above what the reader is looking at does not move it. The view
 * follows the selection only when the selection moves.
 */
export function drawAgentsView(frame: MonitorFrame, state: MonitorState, rows: MonitorRow[], y: number, width: number, height: number,
  head: (summary: string[], range: string) => string, x = 0): void {
  const pinned = Math.min(1,height,rows.length);
  const room = height-pinned;
  const body = Math.max(0,rows.length-pinned);
  const overflow = body > room;
  const shown = room;
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
  frame.panes.push({id:'agents',x,y,width,height,rows,offset,contentLength:rows.length,edge:0,pinned,visible:pinned+shown});
  for (let i = 0; i < pinned+shown; i++) {
    const row = i < pinned ? rows[i] : rows[offset+i];
    if (!row) continue;
    frame.lines[y+i] = fit(row.text,width);
    for (const control of row.controls ?? []) if (control.width > 0 && control.x < width) frame.controls.push({...control,x:x+Math.min(width-1,control.x),y:y+i,width:Math.max(1,Math.min(control.width,width-control.x))});
  }
  if (pinned) {
    // The title spans the frame's sides too, where there is a frame.
    const range = overflow && shown > 0 ? `${offset+1}–${offset+shown}/${body}` : '';
    const summary = [rows[0].text,rows[0].short ?? ''].map(text=>text.replace(/^ /,'')).filter(Boolean);
    frame.lines[y] = head(summary,range);
    frame.controls.push({kind:'zoom',pane:'agents',x:0,y,width:width+2*x});
  }
}
