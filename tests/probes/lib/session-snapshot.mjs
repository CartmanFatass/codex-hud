#!/usr/bin/env node
// Snapshot the pi session files in a directory: one JSON line per .jsonl file
// with size, line count and the structural fields of the first `type: session`
// record. Used by the pi-resume probe.
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: session-snapshot.mjs <session-dir>');
  process.exit(2);
}

const files = fs.existsSync(dir)
  ? fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .sort()
  : [];

for (const name of files) {
  const file = path.join(dir, name);
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n').filter((line) => line.trim());
  let session = null;
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      if (record.type === 'session') {
        session = record;
        break;
      }
    } catch {
      // ignore a partial last line
    }
  }
  console.log(
    JSON.stringify({
      file: name,
      size: fs.statSync(file).size,
      lines: lines.length,
      sessionId: session?.id ?? null,
      cwd: session?.cwd ?? null,
      version: session?.version ?? null,
    })
  );
}
