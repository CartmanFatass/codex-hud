import { globSync, statSync } from 'node:fs';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';

// The CLI sorts even explicit paths alphabetically. Pass run() the ordered files:
// start process-heavy MCP suites first, then larger files before smaller ones in each group.
const files = globSync('tests/unit/*.mjs')
  .map(file => ({ file, mcp: file.startsWith('tests/unit/thin-mcp-'), bytes: statSync(file).size }))
  .sort((a, b) => b.mcp - a.mcp || b.bytes - a.bytes)
  .map(({ file }) => file);
if (!files.length) throw Error('No tests/unit/*.mjs files found');

run({ files, concurrency: process.argv[2] ? Number(process.argv[2]) : true, timeout: 60000, forceExit: true })
  .on('test:summary', ({ success }) => { if (!success) process.exitCode = 1; })
  .compose(spec()).pipe(process.stdout);
