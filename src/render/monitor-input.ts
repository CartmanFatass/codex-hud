/** What a key, a click or the wheel does to the panel: the next state, and anything it asks of the page. */
import type { WorkbenchInput } from '../utils/workbench-input.js';
import type { MonitorContext, MonitorFrame, MonitorOutcome, MonitorPane, MonitorRect, MonitorRow, MonitorState } from './monitor.js';
import { MONITOR_PANES, toggleCard } from './monitor.js';
import { visibleRows, applyKey } from './panel-state.js';
import { WHEEL_ROWS } from './agents-view.js';
import { nextLevel } from './status-foot.js';

/**
 * A click on a pane's button, or its number after the prefix: an open pane
 * closes, a closed one opens and takes focus. Closed, it takes no row, and
 * the focus moves to the next pane still open.
 */
export function clickTab(state: MonitorState, id: MonitorPane): MonitorState {
  // In the tabs layout a tab shows its pane, as a browser's does: none opens or closes.
  if (state.tabbed) return openPane(state,id);
  if (state.modes[id] === 'closed') return openPane({...state,zoom:false},id);
  return closePane(state,id);
}
function closePane(state: MonitorState, id: MonitorPane): MonitorState {
  const modes = {...state.modes,[id]:'closed' as const};
  const focus = state.focus !== id ? state.focus : MONITOR_PANES.find(pane=>modes[pane]!=='closed') ?? id;
  return {...state,modes,zoom:state.zoom && state.focus !== id,focus};
}
function openPane(state: MonitorState, id: MonitorPane): MonitorState {
  const preview = id==='agents'?'agent':id==='worktrees'?'worktree':id==='changes'?'file':state.preview;
  // The tabs layout shows it and leaves the stacked layout's panes as they were.
  const modes = state.tabbed ? state.modes : {...state.modes,[id]:'open' as const};
  return {...state,focus:id,preview,modes,scroll:{...state.scroll,details:preview===state.preview?state.scroll.details:0}};
}
/** The row under a point inside a pane's frame, or nothing on its borders. */
export function monitorRowAt(pane: MonitorRect, x: number, y: number): MonitorRow | undefined {
  const edge = pane.edge ?? 1;
  if (x < pane.x || x >= pane.x + pane.width || y < pane.y + edge || y >= pane.y + pane.height) return undefined;
  // Past the rows drawn is the scroll hint, not a row.
  if (pane.visible !== undefined && y - pane.y - edge >= pane.visible) return undefined;
  const line = y - pane.y - edge < (pane.pinned ?? 0) ? y - pane.y - edge : pane.offset + y - pane.y - edge;
  return line >= 0 ? pane.rows[line] : undefined;
}
export function monitorItemAt(pane: MonitorRect, x: number, y: number): string | undefined {
  return monitorRowAt(pane,x,y)?.item || undefined;
}
export function canMonitorDiff(frame?: MonitorFrame): boolean {
  return Boolean(frame?.panes.some(p=>p.id==='details'&&p.height>1&&p.width>=16));
}
export function handleMonitorInput(state: MonitorState, input: WorkbenchInput, ctx: MonitorContext): MonitorOutcome {
  let next: MonitorState = {...state,tree:{...state.tree},modes:{...state.modes},scroll:{...state.scroll}};
  let key = input.type==='key'?input.key:'';
  const result = (action?:MonitorOutcome['action'],close=false): MonitorOutcome => ({state:next,close,action});
  if(key==='close') return result(undefined,true);
  // Space is Enter, except on the cards, where it opens or closes the selected one.
  if(key==='space')key=next.style==='rich'&&next.focus==='agents'&&!next.help?'expand':'enter';
  if(next.help) {
    const back=input.type==='mouse'&&input.button==='left'&&ctx.frame?.controls.some(c=>c.kind==='help'&&input.y===c.y&&input.x>=c.x&&input.x<c.x+c.width);
    if(back||['escape','help','enter'].includes(key))next.help=false;
    else {
      if(input.type==='mouse')key=input.button==='wheel-down'?'down':input.button==='wheel-up'?'up':'';
      const page=Math.max(1,ctx.frame?.helpPage?.count??1);
      const delta=key==='down'?1:key==='up'?-1:key==='page-down'?page:key==='page-up'?-page:0;
      const max=Math.max(0,(ctx.frame?.helpPage?.total??0)-page);
      next.helpScroll=key==='home'?0:key==='end'?max:Math.max(0,Math.min(max,(next.helpScroll??0)+delta));
    }
    return result();
  }
  if(input.type==='mouse') {
    const control = input.button==='left'?ctx.frame?.controls.find(c=>input.y===c.y&&input.x>=c.x&&input.x<c.x+c.width):undefined;
    if(control?.kind==='main') return result({type:'switch',id:ctx.tree.rootId});
    if(control?.kind==='settings') return result({type:'settings'});
    if(control?.kind==='help'){next.help=true;next.helpScroll=0;return result();}
    if(control?.kind==='older'){next.tree.showAll=!next.tree.showAll;return result();}
    if(control?.kind==='tab'&&control.pane){next=clickTab(next,control.pane);return result();}
    // A pane's band, or the agents' summary: zoom that pane, or restore it.
    if(control?.kind==='zoom'&&control.pane){if(!next.tabbed)next.zoom=!(next.zoom&&next.focus===control.pane);next.focus=control.pane;return result();}
    if(control?.kind==='brief') return result({type:'brief-toggle'});
    if(control?.kind==='level'){next.statusLevel=nextLevel(next);next.statusScroll=0;return result({type:'status-level'});}
    // What was clicked is in view already: selecting it does not scroll.
    const pick=(id: string)=>{next.tree.selectedId=id;next.preview='agent';next.scroll.details=0;next.revealed=id;next.focus='agents';};
    if(control?.kind==='log'&&control.item){pick(control.item);return result();}
    // A card's top rule or its ▾/▴: open or close its timeline, and select it.
    if(control?.kind==='expand'&&control.item){pick(control.item);next=toggleCard(next,control.item);return result();}
    // A card's name: go to that agent's session, as `o` does on it.
    if(control?.kind==='switch'&&control.item){pick(control.item);return result({type:'switch',id:control.item});}
    // The wheel over the status card scrolls its brief, the rows above it stay.
    const card=ctx.frame?.statusCard;
    if(input.button!=='left'&&card&&input.y>=card.y&&input.y<card.y+card.height) {
      if(card.total>card.brief) next.statusScroll=Math.max(0,Math.min(card.total-card.brief,(next.statusScroll??0)+(input.button==='wheel-down'?WHEEL_ROWS:-WHEEL_ROWS)));
      return result();
    }
    {
      const pane=ctx.frame?.panes.find(p=>input.x>=p.x&&input.x<p.x+p.width&&input.y>=p.y&&input.y<p.y+p.height);
      if(!pane) return result();
      next.focus=pane.id;
      if(input.button==='left') {
        {
          const row=monitorRowAt(pane,input.x,input.y);
          const id=row?.item;
          if(!id)return result();
          if(pane.id==='agents') {
            if(!visibleRows(ctx.tree.nodes,next.tree,ctx.nowMs).some(row=>row.node.id===id))return result();
            pick(id);
            // A card is a place to read: a click selects it, `o` switches.
            // A tree row is a list to pick from: a click switches.
            return next.style==='rich'?result():result({type:'switch',id});
          }
          if(pane.id==='worktrees') {next.selectedWorktree=id;next.preview='worktree';}
          if(pane.id==='changes') {next.selectedFile=id;next.preview='file';}
          next.scroll.details=0;return result();
        }
      } else if(pane.id==='agents') {
        // The wheel scrolls what is under it, and leaves the selection be.
        next.scroll.agents=Math.max(0,next.scroll.agents+(input.button==='wheel-down'?WHEEL_ROWS:-WHEEL_ROWS));
        return result();
      } else key=input.button==='wheel-down'?'down':'up';
    }
  }
  if(key==='settings')return result({type:'settings'});
  if(key==='brief-toggle')return result({type:'brief-toggle'});
  // `r` is Reset on the settings page; here it changes how much the status card shows.
  if(key==='reset'){next.statusLevel=nextLevel(next);next.statusScroll=0;return result({type:'status-level'});}
  if(key==='main')return result({type:'switch',id:ctx.tree.rootId});
  if(key==='open-session')return next.focus==='agents'&&next.tree.selectedId?result({type:'switch',id:next.tree.selectedId}):result();
  if(key==='expand'){if(next.style==='rich'&&next.tree.selectedId){next=toggleCard(next,next.tree.selectedId);next.focus='agents';next.revealed=null;}}
  else if(key==='show-all')next.tree.showAll=!next.tree.showAll;
  else if(key==='help'){next.help=true;next.helpScroll=0;}
  else if(key==='pane-close'){if(!next.tabbed&&next.modes[next.focus]!=='closed')next=closePane(next,next.focus);}
  // A pane's number, as its button: open it, or close it.
  else if(MONITOR_PANES.includes(key as MonitorPane))next=clickTab(next,key as MonitorPane);
  else if(key==='tab'||key==='shift-tab') {
    const visible=MONITOR_PANES.filter(id=>next.tabbed||next.modes[id]!=='closed');
    if(visible.length)next.focus=visible[(visible.indexOf(next.focus)+(key==='tab'?1:visible.length-1))%visible.length];
  } else if(key==='enter'||key==='detail-toggle') {
    const from=next.focus;
    if(from==='details') {next.expanded=!next.expanded;next.scroll.details=0;return result();}
    if(from==='agents')next.preview='agent';else if(from==='worktrees')next.preview='worktree';else if(from==='changes')next.preview='file';
    next=openPane(next,'details');next.scroll.details=0;
    next.expanded=false;
    if(from==='changes'&&!next.tabbed)next.zoom=true;
  } else if(key==='zoom'){if(!next.tabbed)next.zoom=!next.zoom;}
  else if(key==='escape') {
    if(next.zoom&&!next.tabbed)next.zoom=false;
    else if(next.focus==='details'){
      // Back to what was inspected; the tabs layout closes nothing on the way.
      if(!next.tabbed)next.modes.details='closed';
      next.focus=next.preview==='agent'?'agents':next.preview==='worktree'?'worktrees':'changes';
    }
    else return result(undefined,true);
  } else {
    const pane=ctx.frame?.panes.find(p=>p.id===next.focus);
    const page=Math.max(1,(pane?.height??5)-(pane?.edge??1));
    // A two-line worktree card is one item, not two keyboard destinations.
    const visibleItems = pane ? new Set(pane.rows.slice(pane.offset,pane.offset+page).flatMap(row=>row.item ? [row.item] : [])) : new Set<string>();
    const itemPage = visibleItems.size || page;
    const delta=key==='down'?1:key==='up'?-1:key==='page-down'?itemPage:key==='page-up'?-itemPage:0;
    const move=delta!==0||key==='home'||key==='end';
    if(next.focus==='agents') {
      const rows=visibleRows(ctx.tree.nodes,next.tree,ctx.nowMs);
      // A page key scrolls the view a page; the selection keys move the
      // selection, and the view follows it there.
      if(key==='page-down'||key==='page-up'){
        const view=Math.max(1,(pane?.visible??page)-(pane?.pinned??0)-1);
        next.scroll.agents=Math.max(0,next.scroll.agents+(key==='page-down'?view:-view));
      } else if(move){next.revealed=null;const index=rows.findIndex(row=>row.node.id===next.tree.selectedId);const target=key==='home'?0:key==='end'?rows.length-1:Math.max(0,index)+delta;
        const row=rows[Math.max(0,Math.min(rows.length-1,target))];if(row)next.tree.selectedId=row.node.id;
      } else if(key==='sort')next.tree.sort=next.tree.sort==='active'?'created':'active';
      else if(['left','right','filter'].includes(key))next.tree=applyKey(next.tree,key as 'left'|'right'|'filter',rows).state;
    } else if(move) {
      const ids=pane?[...new Set(pane.rows.map(row=>row.item).filter((id):id is string=>id!==undefined))]:[];
      if(ids.length&&(next.focus==='worktrees'||next.focus==='changes')) {
        const current=next.focus==='worktrees'?next.selectedWorktree:next.selectedFile;
        const index=ids.indexOf(current??'');const target=key==='home'?0:key==='end'?ids.length-1:Math.max(0,index)+delta;
        const id=ids[Math.max(0,Math.min(ids.length-1,target))];
        if(next.focus==='worktrees'){next.selectedWorktree=id;next.preview='worktree';}else{next.selectedFile=id;next.preview='file';}
      }else next.scroll[next.focus]=key==='home'?0:key==='end'?Math.max(0,(pane?.contentLength??0)-page):Math.max(0,next.scroll[next.focus]+delta);
    }
  }
  if(next.tree.selectedId!==state.tree.selectedId||next.selectedWorktree!==state.selectedWorktree||next.selectedFile!==state.selectedFile)next.scroll.details=0;
  return result();
}
