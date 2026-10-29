/** Synthetic historical counters. No disk, provider or real-session data. */
import type { UsageSnapshot, UsageTotals } from '../../src/usage-types.js';
export const USAGE_NOW=Date.parse('2026-10-28T18:00:00Z');
export const usageTotals=(total:number):UsageTotals=>{const output=Math.round(total/11),input=total-output;
  return {input,cachedInput:input/5,output,reasoningOutput:output*.4,total,events:2,threads:1};};
export function usageSnapshot():UsageSnapshot {
  const self=usageTotals(1100),children=usageTotals(220),total={...usageTotals(1320),events:4,threads:2};
  return {status:'ready',updatedAtMs:USAGE_NOW,range:{startMs:Date.parse('2026-10-28T00:00:00Z'),endMs:USAGE_NOW,timeZone:'UTC'},
    source:{codexHome:'/synthetic/codex-home',label:'sessions + archived_sessions'},totals:total,
    daily:[{day:'2026-10-28',totals:total}],models:[{key:'gpt-6.1-sol',totals:total}],efforts:[{key:'high',totals:total}],
    roles:[{key:null,totals:self},{key:'implementer',totals:children}],tasks:[{rootId:'synthetic-root',self,descendants:children,total}],
    coverage:{filesDiscovered:3,filesIndexed:3,filesUnreadable:0,malformedLines:0,unresolvedParents:0,ambiguousEvents:0}};
}
