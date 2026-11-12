export type JevAskTarget = 'chatgpt-pro' | 'aistudio';

export interface JevAskInput {
  tag: 'ask';
  target: JevAskTarget;
  label: string;
  prompt: string;
  confirmResend?: boolean;
  model?: string;
  thinking?: string;
  effortWord?: string;
  conversation?: string;
  attach?: string;
  dryRun?: boolean;
  maxWaitMs?: number;
}

export type JevJobInput =
  | JevAskInput
  | { tag: 'browse'; goal: string; url: string }
  | { tag: 'judge'; url: string; statements: Array<{ name: string; statement: string }> };
