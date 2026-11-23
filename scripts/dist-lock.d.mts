export type HeapProfile = 'panel' | 'watch' | 'mcp';
export function buildStamp(): string | null;
export function publishGeneration(kind: 'mcp' | 'watcher', stamp: string | null): void;
export function acquireBuildLock(kind: string, root?: URL | string): Promise<import('node:net').Server>;
export function withDistLock<T>(load: () => T | Promise<T>, root?: URL | string): Promise<T>;
export function v8HeapArgs(profile: HeapProfile, env?: NodeJS.ProcessEnv, execArgv?: readonly string[]): string[];
export function applyV8HeapCaps(profile: HeapProfile): void;
