import type { AdapterEvent, NativeRef, NativeRequest } from './types.js';

export interface HostMessage {
  seq: number;
  connectionId: string;
  nativeRef: NativeRef | null;
  event?: AdapterEvent;
  request?: Omit<NativeRequest, 'signal'>;
}
