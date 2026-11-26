import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { reportSignature } from '../../dist/roles/cli-turn.js';
import { cleanupFixture } from './process-cleanup.mjs';
import { fixture, until } from './thin-mcp-harness.mjs';
import { writeFixtureFile } from './thin-mcp-files.mjs';

export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

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

  const issues = join('.scratch', 'sample', 'issues');
  fs.mkdirSync(join(f.root, issues), { recursive: true });
  const ticketPath = (n, feat = 'sample') => join('.scratch', feat, 'issues', `${String(n).padStart(2, '0')}-synthetic.md`);
  if (tickets) {
    for (const [name, body] of Object.entries(tickets)) {
      fs.writeFileSync(join(f.root, issues, name), body);
    }
  } else {
    for (let n = 1; n <= count; n++) {
      fs.writeFileSync(join(f.root, ticketPath(n)), goodTicket(n, { blocked: n === 2 ? secondBlocker : 'none' }));
    }
  }
  for (const [feat, files] of Object.entries(extraFeatures)) {
    const dirPath = join(f.root, '.scratch', feat, 'issues');
    fs.mkdirSync(dirPath, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(join(dirPath, name), body);
    }
  }
  git(f.root, 'add', '.scratch', '.hud', ...(spec !== null ? ['docs'] : []));
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
    }, 15_000);
    return flow(id).tickets.map(x => x.job);
  };
  const settle = async (id, { report = 'Synthetic finished report.\nRemoves: none\n', file, body = 'Synthetic implementation.\n' } = {}) => {
    const receipt = job(id), root = receipt.worktree.root;
    file ??= `${receipt.ticket.replace('/', '-')}.txt`;
    fs.writeFileSync(join(root, file), body);
    git(root, 'add', file); git(root, 'commit', '-qm', file);
    await until(() => Date.now() > Date.parse(receipt.pi_sent_at ?? receipt.created_at) + 1, t.signal);
    writeFixtureFile(join(dir(id), 'report.md'), report);
    writeFixtureFile(join(dir(id), 'STATUS.json'), JSON.stringify({ state: 'closed', output_written: true, settled_at: new Date().toISOString() }));
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
  const settleReview = async id => {
    const receipt = job(id), jobDir = dir(id);
    if (receipt.cli) {
      await until(() => settleCli(id, 'Verdict: accept\n\nNo blocking findings.\n'), 10_000);
      return;
    }
    await until(() => Date.now() > Date.parse(receipt.pi_sent_at ?? receipt.created_at) + 1, t.signal);
    writeFixtureFile(join(jobDir, 'report.md'), 'Verdict: accept\n\nNo blocking findings.\n');
    writeFixtureFile(join(jobDir, 'STATUS.json'), JSON.stringify({ state: 'closed', output_written: true, settled_at: new Date().toISOString() }));
  };
  const settleLead = async (id, report = 'Decision: finish\nReason: Accepted synthetic feature.\n') => {
    await until(() => settleCli(id, report), 10_000);
  };
  const end = async id => {
    await until(() => flow(id).state !== 'working', 25_000);
    return flow(id);
  };
  const fakeLog = () => fs.readFileSync(f.env.FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  return { ...f, dir, end, fakeLog, flow, git, home, issues, job, jobs, settle, settleCli, settleLead, settleReview, ticketPath };
}
