/**
 * Key decoding for the subagent panel.
 *
 * Arrow keys and vi keys do the same things, so neither habit is punished.
 * Enter opens the selected agent rather than closing the panel: closing is
 * `q`, Ctrl+C, or Escape from the top level.
 */

export type TreeKey =
  | 'close'
  | 'back'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'open'
  | 'filter'
  | 'session'
  | 'help'
  | 'top'
  | 'bottom'
  | 'none';

export function parseTreeKey(chunk: Buffer): TreeKey {
  if (chunk.length === 0) {
    return 'none';
  }

  const first = chunk[0];

  // Ctrl+C / Ctrl+D always close, wherever the panel happens to be.
  if (first === 0x03 || first === 0x04) {
    return 'close';
  }

  if (first === 0x0d || first === 0x0a) {
    return 'open';
  }

  if (first === 0x1b) {
    if (chunk.length >= 3 && chunk[1] === 0x5b) {
      switch (chunk[2]) {
        case 0x41:
          return 'up';
        case 0x42:
          return 'down';
        case 0x43:
          return 'right';
        case 0x44:
          return 'left';
        default:
          return 'none';
      }
    }
    // A bare Escape steps back one view, and closes from the top level.
    if (chunk.length === 1) {
      return 'back';
    }
    return 'none';
  }

  switch (String.fromCharCode(first)) {
    case 'q':
    case 'Q':
      return 'close';
    case 'j':
      return 'down';
    case 'k':
      return 'up';
    case 'h':
      return 'left';
    case 'l':
      return 'right';
    case 'g':
      return 'top';
    case 'G':
      return 'bottom';
    case '/':
    case 'f':
      return 'filter';
    case 't':
      return 'session';
    case '?':
      return 'help';
    default:
      return 'none';
  }
}
