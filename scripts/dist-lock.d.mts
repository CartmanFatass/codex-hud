export function buildStamp(): string | null;
export function acquireBuildLock(kind: string, root?: URL | string): Promise<import('node:net').Server>;
export function withDistLock<T>(load: () => T | Promise<T>, root?: URL | string): Promise<T>;
