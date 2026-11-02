/** Optional ledger subset; runtime.ts checks supported releases without raising the bar's Node 18 floor. */
declare module 'node:sqlite' {
  export type SQLInputValue = null | number | bigint | string | NodeJS.ArrayBufferView;
  export type SQLOutputValue = null | number | bigint | string | Uint8Array;
  export class StatementSync {
    all(...params: SQLInputValue[]): Record<string, SQLOutputValue>[];
    get(...params: SQLInputValue[]): Record<string, SQLOutputValue> | undefined;
    run(...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }
  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
