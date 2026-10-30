/** Dashboard colours and token apportionment ported from toktrack a6353d3.
 * Reference: tui/theme.rs, widgets/token_composition.rs; MIT in assets/toktrack/.
 */
import { palette } from './palette.js';
const paint=(dark:string,light:string)=>(text:string)=>palette().name==='none'?text:
  `\x1b[38;2;${(palette().name==='latte'?light:dark).split(',').join(';')}m${text}\x1b[39m`;
export const usageTheme={
  ink:paint('221,230,240','28,43,60'),muted:paint('147,163,184','83,102,124'),
  border:paint('59,75,96','151,167,185'),teal:paint('103,217,193','0,121,106'),
  gold:paint('234,210,122','133,95,0'),mint:paint('110,231,160','21,128,61'),
  warn:paint('242,164,107','184,90,18'),track:paint('86,101,122','150,163,178'),
  parts:[paint('57,135,229','42,120,214'),paint('217,89,38','235,104,52'),paint('25,158,112','27,175,122'),paint('201,133,0','237,161,0'),paint('213,81,129','232,123,164')],
  series:[paint('99,179,237','2,132,199'),paint('167,139,250','124,58,237'),paint('52,211,153','5,150,105'),paint('251,191,36','202,138,4'),paint('244,114,182','219,39,119')],
};
/** Largest remainders, retaining each nonzero part when the width permits. */
export function usageCells(parts:readonly number[],width:number):number[]{
  const total=parts.reduce((a,b)=>a+b,0);if(!total)return parts.map(()=>0);
  const cells=parts.map(n=>Math.floor(n/total*width));
  const order=parts.map((_,i)=>i).sort((a,b)=>(parts[b]/total*width-cells[b])-(parts[a]/total*width-cells[a])||a-b);
  for(const i of order.slice(0,width-cells.reduce((a,b)=>a+b,0)))cells[i]++;
  if(width>=parts.filter(n=>n>0).length)for(let i=0;i<parts.length;i++)if(parts[i]>0&&cells[i]===0){
    const donor=cells.reduce((best,n,j)=>n>=cells[best]?j:best,0);if(cells[donor]>1){cells[donor]--;cells[i]++;}
  }
  return cells;
}
