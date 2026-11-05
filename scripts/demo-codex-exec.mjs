import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CodexExecJsonReader, CODEX_EXEC_SCHEMA } from '../dist/harness/codex/exec-json.js';
const bytes = readFileSync(new URL('../tests/fixtures/codex-exec/completed.jsonl', import.meta.url));
console.log(`SIMULATED codex exec --json, schema ${CODEX_EXEC_SCHEMA}`);
for (const resumed of [false, true]) {
  const reader = new CodexExecJsonReader(resumed ? 'synthetic-thread-1' : undefined);
  for (let i = 0; i < bytes.length; i += 7) reader.push(bytes.subarray(i, i + 7));
  const result = reader.finish({ code: 0 });
  assert.equal(result.complete, true);
  console.log(
    JSON.stringify(
      {
        simulated: true,
        invocation: resumed ? 'codex exec --json resume synthetic-thread-1' : 'codex exec --json',
        observation: result,
      },
      null,
      2
    )
  );
}
console.log(
  'PASS: HUD exec observation parser consumed chunked fixture and same-thread simulated resume. No subprocess, account, settings or network used. Not real-client verification.'
);
