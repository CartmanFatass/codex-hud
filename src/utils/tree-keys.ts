export type TreeKey = 'close' | 'up' | 'down' | 'none';

export function parseTreeKey(chunk: Buffer): TreeKey {
  if (chunk.length === 0) {
    return 'none';
  }
  const first = chunk[0];
  if (first === 0x03 || first === 0x04 || first === 0x0d || first === 0x0a) {
    return 'close';
  }
  if (first === 0x1b) {
    if (chunk.length >= 3 && chunk[1] === 0x5b) {
      if (chunk[2] === 0x41) return 'up';
      if (chunk[2] === 0x42) return 'down';
      return 'none';
    }
    if (chunk.length === 1) {
      return 'close';
    }
    return 'none';
  }
  const text = chunk.toString('utf8');
  if (/q/i.test(text)) {
    return 'close';
  }
  return 'none';
}
