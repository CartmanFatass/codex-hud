import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repo } from './common.mjs';

const directory = process.argv[2];
const expected = ['01-identity', '02-execution', '04-supervision']
  .flatMap((name) =>
    [
      ...readFileSync(join(repo, `docs/contracts/${name}.md`), 'utf8').matchAll(/^\| (T-\d+-\d+) \(A9 prototype\)/gm),
    ].map((match) => match[1])
  )
  .sort();
const lines = ['identity', 'execution', 'recovery'].flatMap((group) =>
  readFileSync(join(directory, `${group}.log`), 'utf8').split('\n')
);
const actual = lines.flatMap((line) => /^(PASS|FAIL) (T-\d+-\d+) /.exec(line)?.[2] || []).sort();
const failed = lines.filter((line) => /^FAIL T-/.test(line)).length;
try {
  assert.equal(expected.length, 21);
  assert.deepEqual(actual, expected);
  console.log(`COUNT contract=${expected.length} printed=${actual.length} unique=${new Set(actual).size} equal=true`);
  console.log(`SUMMARY total=${actual.length} pass=${actual.length - failed} fail=${failed}`);
  if (failed) process.exitCode = 1;
} catch (error) {
  console.error(`COUNT FAIL ${error.message}`);
  process.exitCode = 1;
}
