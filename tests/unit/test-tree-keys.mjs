import assert from 'node:assert/strict';
import { parseTreeKey } from '../../dist/utils/tree-keys.js';

assert.equal(parseTreeKey(Buffer.from('q')), 'close');
assert.equal(parseTreeKey(Buffer.from([0x03])), 'close');
assert.equal(parseTreeKey(Buffer.from([0x1b])), 'close');
assert.equal(parseTreeKey(Buffer.from([0x1b, 0x5b, 0x41])), 'up');
assert.equal(parseTreeKey(Buffer.from([0x1b, 0x5b, 0x42])), 'down');
assert.equal(parseTreeKey(Buffer.from([0x1b, 0x5b, 0x43])), 'none');
assert.equal(parseTreeKey(Buffer.from('x')), 'none');

console.log('test-tree-keys: PASS');
