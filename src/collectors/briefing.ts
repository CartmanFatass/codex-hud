import type { AgentTaskKind } from '../types.js';
import type { Recap } from './recap.js';

export interface BriefItem {
  agent: string;
  note: string;
  attention: boolean;
  label?: string;
  kind?: AgentTaskKind;
}

export interface Brief {
  text?: string;
  overall?: string;
  items?: BriefItem[];
  at?: number;
  running?: boolean;
  error?: string;
  structured?: boolean;
  recap?: Recap;
}
