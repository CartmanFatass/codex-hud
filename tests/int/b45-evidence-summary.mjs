// Read only the explicit B45-owned synthetic probe evidence directories.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv[2];
if (!root?.startsWith('/')) throw new Error('Absolute B45 evidence directory required');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const groups = new Map(),
  latencies = [],
  runs = [],
  directories = [];
const stats = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const p = (q) => s[Math.max(0, Math.ceil(s.length * q) - 1)] ?? null;
  return { n: s.length, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: s.at(-1) ?? null };
};
for (const directory of readdirSync(root)
  .filter((name) => /^real-\d+$/.test(name))
  .sort()) {
  const names = readdirSync(join(root, directory));
  for (const file of names.filter((name) => name.endsWith('-parent.json'))) {
    const data = read(join(root, directory, file));
    directories.push({
      evidence: directory,
      project: data.project,
      home: data.home,
      ...(data.claudeProjectDirectory ? { claudeProjectDirectory: data.claudeProjectDirectory } : {}),
    });
  }
  for (const file of names.filter((name) => name.endsWith('-calls.jsonl'))) {
    const rows = readFileSync(join(root, directory, file), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse);
    for (const row of rows) {
      const kind = row.jointUpperMs === null ? 'Codex-direct' : 'Claude-hook';
      const outcome = row.outcome?.ok ? 'success' : row.outcome?.code === 'busy' ? 'busy' : 'refusal';
      const key = [kind, row.tool, outcome].join('/');
      const g = groups.get(key) ?? { mcp: [], joint: [] };
      g.mcp.push(row.mcpMs);
      if (row.jointUpperMs !== null) g.joint.push(row.jointUpperMs);
      groups.set(key, g);
    }
  }
  for (const file of names.filter((name) => name.endsWith('-ledger.json') && !name.startsWith('post-'))) {
    const data = read(join(root, directory, file));
    runs.push({
      evidence: directory,
      kind: file.split('-')[0],
      runCount: data.runs.length,
      reportCount: data.reports.length,
      submissions: data.events.filter((e) => e.kind === 'launch.submitting').length,
      states: data.runs.map((r) => r.state),
      heldSlots: data.slots.length,
    });
    for (const run of data.runs) {
      const bound = data.events.find((e) => e.run_id === run.run_id && e.kind === 'child.bound');
      latencies.push({
        evidence: directory,
        runId: run.run_id,
        runSeq: run.run_seq,
        acceptedToStartedMs: run.started_at === null ? null : run.started_at - run.created_at,
        acceptedToBoundMs: bound ? bound.at - run.created_at : null,
        startedToBoundMs: bound && run.started_at !== null ? bound.at - run.started_at : null,
      });
    }
  }
}
const starts = readFileSync(join(root, 'real-runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const result = {
  kind: 'real-B45-bounded-evidence',
  budget: {
    codex: starts.filter((r) => r.harness === 'codex').length,
    claude: starts.filter((r) => r.harness === 'claude').length,
    limitEach: 30,
    includesFailedLauncherAttempts: true,
  },
  timings: Object.fromEntries(
    [...groups].map(([key, value]) => [key, { mcpMs: stats(value.mcp), jointUpperMs: stats(value.joint) }])
  ),
  runs,
  latencies,
  directories,
  limitations: [
    'Real and synthetic samples are separate.',
    'Real mcpMs includes source resolution and tool handling, before JSON serialization/response flush. Claude jointUpperMs includes cold hook start through response flush.',
    'Small real n does not meet B14 promotion gate; shipped cells remain unverified.',
    'real-07 launcher import failure had zero callers/intents and zero owned processes on post-crash evidence; its parent attempt is still counted.',
  ],
};
writeFileSync(join(root, 'real-summary.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
