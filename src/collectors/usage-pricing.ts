/**
 * Port of toktrack a6353d3 services/pricing.rs for Codex usage records.
 * Model lookup, custom overrides, per-request token tiers and Fast multipliers
 * follow the reference. MIT attribution and offline table: assets/toktrack/.
 * No provider requests, cache refresh subprocesses or credential reads.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import TOML from '@iarna/toml';
import type { Counts } from './usage-records.js';

export interface UsageCost { usd: number | null; pricedEvents: number; unpricedEvents: number }
export interface UsageRates { input: number; output: number; cachedInput: number; firstTier: number | null; key: string; custom: boolean }
type Rates = Record<string, unknown>;
type Table = Record<string, Rates>;
const record=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const rate=(v:unknown):number|undefined=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:undefined;
const dashed=(id:string)=>id.toLowerCase().replaceAll('.','-');
const base=(id:string)=>id.split('::')[0].replace(/:fast$/,'');
const aliases:Record<string,string>={'gemini-default':'gemini-3-5-flash','gemini/default':'gemini-3-5-flash',
  'gemini-3-flash-a':'gemini-3-flash-preview','gemini/gemini-3-flash-a':'gemini-3-flash-preview',
  'gemini-3-pro-a':'gemini-3-pro-preview','gemini/gemini-3-pro-a':'gemini-3-pro-preview'};
const form=(id:string)=>aliases[base(id).toLowerCase()]??dashed(base(id)).replace(/-20\d{6}$/,'');
const customForm=(id:string)=>form(id).replace(/^zai-(?=glm-)/,'');
const contains=(id:string,key:string)=>id===key||id.includes(key)&&new RegExp(`(^|[^a-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}([^a-z0-9]|$)`).test(id);
const tier=(p:Rates,name:string):[number,number]|null=>{
  for(const n of name==='cache_read_input_token_cost'?[200,272]:[128,200,256,272]){const v=rate(p[`${name}_above_${n}k_tokens`]);if(v!==undefined)return [n*1000,v];}return null;
};
const charge=(tokens:number,p:Rates,name:string)=>{const normal=rate(p[name])??0,step=tier(p,name);
  return step&&tokens>step[0]?step[0]*normal+(tokens-step[0])*step[1]:tokens*normal;};
const customFields:Record<string,string>={input:'input_cost_per_token',output:'output_cost_per_token',cache_read:'cache_read_input_token_cost',
  input_above_200k:'input_cost_per_token_above_200k_tokens',output_above_200k:'output_cost_per_token_above_200k_tokens',cache_read_above_200k:'cache_read_input_token_cost_above_200k_tokens'};
function customRates(value:unknown):Rates{
  const p=record(value),out:Rates={};for(const [key,target] of Object.entries(customFields)){const n=rate(p[key]);if(n!==undefined)out[target]=n/1e6;}return out;
}

export class UsagePricing {
  private table:Table={};
  private custom:Table={};
  private index=new Map<string,string>();
  private memo=new Map<string,string|null>();
  source='unavailable';
  revision='';
  updatedAtMs:number|null=null;
  constructor(private readonly options:{cacheFile?:string;customFile?:string;table?:Table;custom?:Table}={}){
    if(options.table){this.table=options.table;this.custom=options.custom??{};this.source='fixture';this.prepare();}
  }
  fresh():UsagePricing{return new UsagePricing(this.options);}
  async load():Promise<void>{
    if(this.options.table)return;
    const cache=this.options.cacheFile??path.join(os.homedir(),'.toktrack','pricing.json');
    let loaded=false;
    for(const [file,label] of [[cache,'toktrack cache'],[new URL('../../assets/toktrack/pricing.json',import.meta.url),'toktrack bundled snapshot'],
      [new URL('../../../assets/toktrack/pricing.json',import.meta.url),'toktrack bundled snapshot']] as const){
      try{const data=record(JSON.parse(await fs.readFile(file,'utf8')));const models=record(data.models??data);
        if(!Object.values(models).some(p=>Object.keys(record(p)).some(key=>key.includes('cost_per_token'))))continue;
        this.table=Object.fromEntries(Object.entries(models).map(([k,v])=>[k,record(v)]));this.source=label;
        this.updatedAtMs=typeof data.fetched_at==='number'?data.fetched_at*1000:null;loaded=true;break;
      }catch{/* Fall back to the reference's offline table. */}
    }
    if(!loaded&&Object.keys(this.table).length===0)this.source='unavailable';
    this.custom={};
    try{const file=this.options.customFile??process.env.TOKTRACK_PRICING_FILE??path.join(os.homedir(),'.toktrack','pricing.toml');
      const data=record(TOML.parse(await fs.readFile(file,'utf8')));
      this.custom=Object.fromEntries(Object.entries(record(data.models)).map(([k,v])=>[k,customRates(v)]));
    }catch{/* Invalid custom TOML never reaches terminal diagnostics with its contents. */}
    this.prepare();
  }
  private prepare():void{
    this.index.clear();this.memo.clear();for(const key of Object.keys(this.table).sort())if(!this.index.has(dashed(key)))this.index.set(dashed(key),key);
    this.revision=createHash('sha256').update(JSON.stringify([this.table,this.custom])).digest('hex');
  }
  private key(model:string):string|null{
    const id=base(model);if(this.table[id])return id;
    const direct=this.index.get(dashed(id))??this.index.get(form(id));if(direct)return direct;
    const normalized=form(id);if(this.memo.has(normalized))return this.memo.get(normalized)!;
    let best:string|null=null;
    for(const [candidate,key] of this.index){
      if(key.includes('/')||/(?:^|[^0-9])\.|\.(?:$|[^0-9])/.test(key))continue;
      if(contains(normalized,candidate)&&(!best||key.length>best.length||(key.length===best.length&&key<best)))best=key;
    }
    for(const [name,replacement] of [['gemini-3-pro-preview','gemini-3.1-pro-preview'],['gpt-5-3-codex-spark',null]] as const){
      if(contains(normalized,name)&&(!best||best.length<name.length))best=replacement?this.index.get(dashed(replacement))??null:null;
    }
    this.memo.set(normalized,best);return best;
  }
  private resolve(model:string,listing=false):{rates:Rates;key:string;custom:boolean}|null{
    const id=base(model);if(this.custom[id])return {rates:this.custom[id],key:id,custom:true};
    const candidates=Object.keys(this.custom).filter(k=>customForm(k)===customForm(id)).sort();
    if(candidates.length&&candidates.every(k=>JSON.stringify(this.custom[k])===JSON.stringify(this.custom[candidates[0]])))return {rates:this.custom[candidates[0]],key:candidates[0],custom:true};
    if(listing&&candidates.length)return null;
    const key=this.key(id);return key?{rates:this.table[key],key,custom:false}:null;
  }
  private speed(model:string,fast:boolean,provider?:string|null):number{
    if(!fast&&!model.split('::')[0].endsWith(':fast'))return 1;
    const key=this.key(model),p=key?this.table[key]:{};
    const supplied=rate(record(p.provider_specific_entry).fast);if(supplied!==undefined)return supplied;
    const source=provider??model.split('::')[1];if(source&&source!=='openai')return 1;
    const normalized=form(model);
    if(normalized==='gpt-5-5')return 2.5;
    return ['gpt-5-3-codex','gpt-5-4','gpt-5-6','gpt-5-6-sol','gpt-5-6-terra','gpt-5-6-luna','gpt-6-astra'].includes(normalized)?2:1;
  }
  quote(model:string|null,counts:Counts,fast=false,provider?:string|null):UsageCost{
    const unknown:UsageCost={usd:null,pricedEvents:0,unpricedEvents:1};
    if(!model)return unknown;const found=this.resolve(model);if(!found)return unknown;
    const [input,cached,output]=counts;
    if(input===null||cached===null||output===null||cached>input)return unknown;
    const p=found.rates;
    if(!['input_cost_per_token','output_cost_per_token','cache_read_input_token_cost'].some(k=>rate(p[k])!==undefined))return unknown;
    // Codex in toktrack normalizes input to non-cached and leaves reasoning in
    // output (reasoning_tokens=0). Preserve that exact billing convention.
    const usd=(charge(input-cached,p,'input_cost_per_token')+charge(output,p,'output_cost_per_token')
      +charge(cached,p,'cache_read_input_token_cost'))*this.speed(model,fast,provider);
    return Number.isFinite(usd)?{usd,pricedEvents:1,unpricedEvents:0}:unknown;
  }
  list(model:string):UsageRates|null{
    const found=this.resolve(model,true);if(!found)return null;const p=found.rates,speed=this.speed(model,false);
    const thresholds=['input_cost_per_token','output_cost_per_token','cache_read_input_token_cost'].flatMap(k=>{const n=tier(p,k);return n?[n[0]]:[];});
    return {input:(rate(p.input_cost_per_token)??0)*1e6*speed,output:(rate(p.output_cost_per_token)??0)*1e6*speed,
      cachedInput:(rate(p.cache_read_input_token_cost)??0)*1e6*speed,firstTier:thresholds.length?Math.min(...thresholds):null,key:found.key,custom:found.custom};
  }
}
