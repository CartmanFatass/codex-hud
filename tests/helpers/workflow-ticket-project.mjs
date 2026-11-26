import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { reportSignature } from '../../dist/roles/cli-turn.js';
import { statsMtimeMs } from '../../dist/roles/job-index-cache.js';
import { parseMarkdownTicket } from '../../dist/tickets/migrate.js';
import { serializeTicketFeature } from '../../dist/tickets/store.js';
import { cleanupFixture } from './process-cleanup.mjs';
import { fixture, until } from './thin-mcp-harness.mjs';
import { writeFixtureFile } from './thin-mcp-files.mjs';

export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

export function promptNotices(f, flow) {
  const pane = f.flow(flow).pane;
  return f.fakeLog()
    .filter(c => c.command === 'herdr' && c.args[0] === 'agent' && c.args[1] === 'prompt' && c.args[2] === pane)
    .map(c => c.args[3])
    .filter(line => typeof line === 'string' && line.includes(flow));
}

export async function collectDeliveredNotices(f, flow, read, expected = 1, signal = 5_000) {
  const fromChanges = (read.changes ?? []).filter(line => line.includes(flow));
  await until(() => fromChanges.length + promptNotices(f, flow).length >= expected, signal);
  return [...fromChanges, ...promptNotices(f, flow)];
}

export const goodTicket = (n, {
  blocked = 'none',
  liveTry = 'none',
  ownerTry = 'no',
  approvedRemovals,
  objective,
  status = 'ready-for-agent',
  title = `Synthetic ${n}`,
  what = `Synthetic change ${n}`,
} = {}) => [
  `# ${String(n).padStart(2, '0')}: ${title}`,
  '',
  `**Status:** ${status}`,
  `**Owner try:** ${ownerTry}`,
  `**Live try:** ${liveTry}`,
  ...(approvedRemovals !== undefined ? [`**Approved removals:** ${approvedRemovals}`] : []),
  `**Blocked by:** ${blocked}`,
  ...(objective ? [`**Objective:** ${objective}`] : []),
  '',
  `**What to build:** ${what}`,
  '',
  '- [ ] Checked',
  '',
  '## Comments',
  '',
].join('\n');

export async function setupWorkflowProject(t, {
  tickets,
  extraFeatures = {},
  secondBlocker = '01',
  count = 2,
  objectives = '## selected: Selected\n**State:** active\n**Features:** sample\n\n## other: Other\n**State:** active\n',
  spec = '# Synthetic spec\n',
  legacy = false,
  fixtureOptions,
} = {}) {
  const f = await fixture(t, { failedRetentionMs: 30_000, ...fixtureOptions });
  cleanupFixture(t, { root: `${f.root}-wt` });
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: f.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(f.root, 'init', '-qb', 'base');
  git(f.root, 'config', 'user.name', 'Synthetic');
  git(f.root, 'config', 'user.email', 'synthetic@example.invalid');
  fs.mkdirSync(join(f.root, '.hud'));
  fs.writeFileSync(join(f.root, '.hud/project.json'), JSON.stringify({ land: { base: 'base', gate: ['true'], after: [], push: false } }));
  fs.writeFileSync(join(f.root, '.hud/brief.md'), 'Synthetic standing brief.\n');
  if (objectives !== null) fs.writeFileSync(join(f.root, '.hud/objectives.md'), objectives);
  if (spec !== null) {
    fs.mkdirSync(join(f.root, 'docs'));
    fs.writeFileSync(join(f.root, 'docs/spec.md'), spec);
  }
  fs.writeFileSync(join(f.env.HUD_HOME, 'projects.json'), JSON.stringify({ version: 1, projects: [{ root: f.root }] }));

  const legacyFeatures = new Set();
  const at = '2026-01-01T00:00:00.000Z';
  const seedFeature = (feat, files) => {
    const entries = Object.entries(files);
    if (!entries.length) return;
    const parsed = [];
    let useLegacy = legacy;
    if (!useLegacy) {
      for (const [name, body] of entries) {
        const match = /^(\d+)-.+\.md$/.exec(name);
        if (!match) { useLegacy = true; break; }
        // Preserve raw Markdown when a test intentionally omits Live try or sets empty Approved removals to exercise validation gaps.
        if (!/Live try:/i.test(body) || /\*\*Approved removals:\*\*[ \t]*$/im.test(body)) { useLegacy = true; break; }
        const res = parseMarkdownTicket(body, Number(match[1]), feat, at);
        if ('error' in res) { useLegacy = true; break; }
        parsed.push(res.record);
      }
    }
    if (useLegacy) {
      legacyFeatures.add(feat);
      const dirPath = join(f.root, '.scratch', feat, 'issues');
      fs.mkdirSync(dirPath, { recursive: true });
      for (const [name, body] of entries) fs.writeFileSync(join(dirPath, name), body);
    } else {
      fs.mkdirSync(join(f.root, '.hud', 'tickets'), { recursive: true });
      fs.writeFileSync(join(f.root, '.hud', 'tickets', `${feat}.json`), serializeTicketFeature({ version: 1, feature: feat, tickets: parsed }));
    }
  };
  const ticketPath = (n, feat = 'sample') =>
    legacyFeatures.has(feat) ? join('.scratch', feat, 'issues', `${String(n).padStart(2, '0')}-synthetic.md`) : `.hud/tickets/${feat}.json`;
  const ticketRecord = (n, feat = 'sample', rev) => {
    const rel = `.hud/tickets/${feat}.json`;
    const raw = rev ? git(f.root, 'show', `${rev}:${rel}`) : fs.readFileSync(join(f.root, rel), 'utf8');
    return JSON.parse(raw).tickets.find(item => item.number === n);
  };
  const writeJsonTicket = (n, opts = {}, feat = 'sample') => {
    const rel = `.hud/tickets/${feat}.json`, full = join(f.root, rel);
    fs.mkdirSync(join(f.root, '.hud', 'tickets'), { recursive: true });
    const doc = fs.existsSync(full) ? readJson(full) : { version: 1, feature: feat, tickets: [] };
    const parsed = parseMarkdownTicket(goodTicket(n, opts), n, feat, at);
    if ('error' in parsed) throw new Error(parsed.error);
    doc.tickets = [...doc.tickets.filter(item => item.number !== n), parsed.record];
    writeFixtureFile(full, serializeTicketFeature(doc));
    return rel;
  };
  const sampleFiles = tickets ?? Object.fromEntries(Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return [`${String(n).padStart(2, '0')}-synthetic.md`, goodTicket(n, { blocked: n === 2 ? secondBlocker : 'none' })];
  }));
  seedFeature('sample', sampleFiles);
  for (const [feat, files] of Object.entries(extraFeatures)) seedFeature(feat, files);
  const toAdd = ['.hud', ...(legacyFeatures.size ? ['.scratch'] : []), ...(spec !== null ? ['docs'] : [])];
  git(f.root, 'add', ...toAdd);
  git(f.root, 'commit', '-qm', 'synthetic tickets');

  const home = f.env.HUD_HOME;
  const flow = id => readJson(join(home, 'flows', `${id}.json`));
  const dir = id => join(home, 'jobs', id);
  const job = id => readJson(join(dir(id), 'job.json'));
  const jobs = async (id, n) => {
    await until(() => {
      const q = flow(id);
      assert.equal(q.state, 'working', JSON.stringify(q));
      return q.tickets.filter(x => x.job).length === n;
    }, t.signal);
    return flow(id).tickets.map(x => x.job);
  };
  const writeFreshPiReport = async (jobDir, receipt, report) => {
    const sent = Date.parse(receipt.pi_sent_at ?? receipt.created_at);
    const reportPath = join(jobDir, 'report.md');
    let mtime = 0;
    await until(() => {
      writeFixtureFile(reportPath, report);
      mtime = statsMtimeMs(fs.statSync(reportPath, { bigint: true }).mtimeNs);
      return mtime > sent;
    }, t.signal);
    const settledAt = new Date(Math.max(Date.now(), Math.ceil(mtime))).toISOString();
    writeFixtureFile(join(jobDir, 'STATUS.json'), JSON.stringify({ state: 'closed', output_written: true, settled_at: settledAt }));
  };
  const settle = async (id, { report = 'Synthetic finished report.\nRemoves: none\n', file, body = 'Synthetic implementation.\n' } = {}) => {
    const receipt = job(id), root = receipt.worktree.root;
    file ??= `${receipt.ticket.replace('/', '-')}.txt`;
    fs.writeFileSync(join(root, file), body);
    git(root, 'add', file); git(root, 'commit', '-qm', file);
    await writeFreshPiReport(dir(id), receipt, report);
  };
  const settleCli = (id, report) => {
    const jobDir = dir(id);
    const turnPath = join(jobDir, 'turn.json');
    if (!fs.existsSync(turnPath)) return false;
    const turn = readJson(turnPath);
    writeFixtureFile(join(jobDir, 'report.md'), report);
    const sig = reportSignature(jobDir);
    if (!sig) return false;
    writeFixtureFile(join(jobDir, 'done.json'), JSON.stringify({ seq: turn.seq, sent_at: turn.sent_at, report_sig: sig, at: new Date().toISOString() }));
    writeFixtureFile(join(jobDir, 'STATUS.json'), JSON.stringify({ state: 'closed', output_written: true, settled_at: new Date().toISOString() }));
    return true;
  };
  const settleReport = async (id, report) => {
    const receipt = job(id), jobDir = dir(id);
    if (receipt.cli) {
      await until(() => settleCli(id, report), t.signal);
      return;
    }
    await writeFreshPiReport(jobDir, receipt, report);
  };
  const settleReview = id => settleReport(id, 'Verdict: accept\n\nNo blocking findings.\n');
  const settleLead = async (id, report = 'Decision: finish\nReason: Accepted synthetic feature.\n') => {
    await until(() => settleCli(id, report), t.signal);
  };
  const end = async id => {
    await until(() => flow(id).state !== 'working', t.signal);
    return flow(id);
  };
  const fakeLog = () => fs.readFileSync(f.env.FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const issues = join('.scratch', 'sample', 'issues');
  return { ...f, dir, end, fakeLog, flow, git, home, issues, job, jobs, settle, settleCli, settleLead, settleReport, settleReview, ticketPath, ticketRecord, writeJsonTicket };
}
