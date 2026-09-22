import assert from 'node:assert/strict';
import { parseTreeKey } from '../../dist/utils/tree-keys.js';

// Closing is deliberate: q, Ctrl+C or Ctrl+D. A bare Escape steps back one
// view instead, and only closes when there is no view left to step back to,
// which is the panel's decision rather than the decoder's.
assert.equal(parseTreeKey(Buffer.from('q')), 'close');
assert.equal(parseTreeKey(Buffer.from('Q')), 'close');
assert.equal(parseTreeKey(Buffer.from([0x03])), 'close');
assert.equal(parseTreeKey(Buffer.from([0x04])), 'close');
assert.equal(parseTreeKey(Buffer.from([0x1b])), 'back');

// Arrows and vi keys are the same four moves, so neither habit is punished.
assert.equal(parseTreeKey(Buffer.from([0x1b, 0x5b, 0x41])), 'up');
assert.equal(parseTreeKey(Buffer.from([0x1b, 0x5b, 0x42])), 'down');
assert.equal(parseTreeKey(Buffer.from([0x1b, 0x5b, 0x43])), 'right');
assert.equal(parseTreeKey(Buffer.from([0x1b, 0x5b, 0x44])), 'left');
assert.equal(parseTreeKey(Buffer.from('k')), 'up');
assert.equal(parseTreeKey(Buffer.from('j')), 'down');
assert.equal(parseTreeKey(Buffer.from('l')), 'right');
assert.equal(parseTreeKey(Buffer.from('h')), 'left');

assert.equal(parseTreeKey(Buffer.from([0x0d])), 'open', 'Enter opens, it does not close');
assert.equal(parseTreeKey(Buffer.from([0x0a])), 'open');
assert.equal(parseTreeKey(Buffer.from('g')), 'top');
assert.equal(parseTreeKey(Buffer.from('G')), 'bottom');
assert.equal(parseTreeKey(Buffer.from('/')), 'filter');
assert.equal(parseTreeKey(Buffer.from('f')), 'filter');
assert.equal(parseTreeKey(Buffer.from('t')), 'session');
assert.equal(parseTreeKey(Buffer.from('?')), 'help');

// An unrecognised key does nothing at all, rather than the nearest thing.
assert.equal(parseTreeKey(Buffer.from('x')), 'none');
assert.equal(parseTreeKey(Buffer.from([0x1b, 0x5b, 0x5a])), 'none');
assert.equal(parseTreeKey(Buffer.alloc(0)), 'none');

console.log('test-tree-keys: PASS');
