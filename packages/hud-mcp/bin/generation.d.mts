type Method = (...args: never[]) => unknown;
export interface Generation<T extends Record<keyof T, Method>> {
  call<K extends keyof T>(method: K, ...args: Parameters<T[K]>): Promise<Awaited<ReturnType<T[K]>>>;
  retire(): void;
}
export function openGeneration<T extends Record<keyof T, Method>>(url: URL, onEvent?: (event: string) => void,
  initial?: boolean): Promise<Generation<T>>;
