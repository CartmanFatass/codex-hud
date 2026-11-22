export const parserProse = 'The parser boundary update is in place.';
export const checkFailed = 'failed — rejects empty input';
export const probeNotDone = 'The native probe was not run.';
export const parserReport = [
  '# Report',
  '## Files changed',
  '- src/synthetic-parser.ts: updated boundary handling',
  '1. tests/synthetic-parser.test.ts: added an empty-input case',
  '',
  parserProse,
  '## Implementation',
  'Synthetic implementation detail.\n'.repeat(1600),
  '## Tests',
  '### Unit tests',
  '- `npm run check:parser`: ' + checkFailed,
  '3. **Anything in the brief you did not do, and why.**',
  '',
  '   - ' + probeNotDone,
  '## Open questions',
  '- Can the owner run the native probe?',
].join('\n');

export const migrationProse = 'The synthetic migration is staged.';
export const approvalNeeded = 'Deployment cannot proceed without the owner’s approval.';
export const migrationReport = [
  'Synthetic report',
  '================',
  '',
  'File | Change',
  '--- | ---',
  'migration.ts | staged',
  '',
  '* * *',
  '~~~sh',
  'Tests: a command in this fence is not result evidence',
  '~~~',
  '1. migration.ts: staged',
  '   A continuation of the list item.',
  migrationProse,
  '## Notes',
  'UNRELATED-MIDDLE\n'.repeat(20),
  '迁移细节'.repeat(600),
  approvalNeeded,
].join('\n');
