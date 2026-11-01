#!/usr/bin/env node
// Read-only summary of a Codex logs_2.sqlite for the dual-home probe.
//
// Usage: node logs-query.mjs <logs_2.sqlite> <since-epoch-seconds> [needle]
// Prints JSON: row count, thread ids, process uuids, target counts and, when a
// needle is given, how many rows mention it (thread_id or log body).
import { DatabaseSync } from 'node:sqlite';

const [file, sinceArg, needle] = process.argv.slice(2);
if (!file || !sinceArg) {
  console.error('usage: logs-query.mjs <logs_2.sqlite> <since-epoch-seconds> [needle]');
  process.exit(2);
}

const since = Number(sinceArg);
const db = new DatabaseSync(file, { readOnly: true });
const rows = db
  .prepare('select id, ts, level, target, thread_id, process_uuid from logs where ts >= ? order by id')
  .all(since);

const threadIds = [...new Set(rows.map((row) => row.thread_id).filter(Boolean))].sort();
const processUuids = [...new Set(rows.map((row) => row.process_uuid).filter(Boolean))].sort();
const targets = {};
for (const row of rows) targets[row.target] = (targets[row.target] || 0) + 1;

const summary = {
  file,
  since,
  rowCount: rows.length,
  threadIds,
  processUuids,
  targets,
};

if (needle) {
  const needles = needle.split(',').filter(Boolean);
  summary.needles = needles.map((value) => {
    const hit = db
      .prepare('select count(*) as n from logs where thread_id = ? or feedback_log_body like ? or process_uuid like ?')
      .get(value, `%${value}%`, `%${value}%`);
    return { needle: value, hits: hit.n };
  });
}

console.log(JSON.stringify(summary, null, 2));
db.close();
