import { constants, createWriteStream, existsSync } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { readFileBounded, writePrivateFile } from '../../utils/atomic-fs.js';
import type { Role, RolePlace } from '../../roles/roster.js';
import { readReportMeta } from '../../roles/report-meta.js';
import type { Job } from '../job-contracts.js';
import { jobFiles } from '../paths.js';
import { bundled, directory, digestLine, fallbackResultLine, readCachedStatus, RESULT_HEAD_BYTES, save, writeCreateStatus } from '../store/job-store.js';
import { synthesisTemplate } from '../council-settle.js';
export { synthesisTemplate };
import { waitChildReport } from './child-report.js';
import { councilIndex } from './council-index.js';
import type { Args } from './context.js';
import { plainSkillName } from './harness-pi.js';
import type { registry } from './places.js';

type Registry = ReturnType<typeof registry>;
export type CouncilSeat = { preset: string; place: RolePlace };
export type CouncilPlan = { members: CouncilSeat[]; synthesizer: CouncilSeat | 'main'; instructions: string; browserInstructions?: string };
export function prepareCouncil(args: Args, role: Role, found: Registry, configured: Map<string, Role>, routing: ReturnType<Registry['routing']>): CouncilPlan | { ok: false; code: string; reason: string } {
  const members = args.members === undefined ? role.members : args.members;
  const synthesizer = args.synthesizer === undefined ? role.synthesizer : args.synthesizer;
  const names = role.presets!.map(p => p.name);
  const invalid = (reason: string, code = 'invalid_arguments') => ({ ok: false as const, code,
    reason: `${reason}. Valid council presets: ${names.join(', ')} (or main for synthesis).` });
  if (!Array.isArray(members) || members.length < 2 || members.length > 5) return invalid('Choose 2–5 member presets');
  const seats = new Map<string, CouncilSeat>();
  for (const name of [...members, ...(synthesizer === 'main' ? [] : [synthesizer])]) {
    if (typeof name !== 'string' || !names.includes(name)) return invalid(`Unknown council preset ${JSON.stringify(name)}`);
    const assignment = found.assignment(role, Date.now(), undefined, routing, { preset: name });
    const place = assignment.runs_on;
    if (!place) return invalid(`${name} unavailable: ${assignment.reason}. Check Control → Harnesses and the executable on PATH`, 'role_unavailable');
    if (place.harness === 'bro' && !configured.get('pro')?.optionalEnabled)
      return invalid(`Browser preset ${name} requires pro. Enable pro in Control → Roles (Space) or $HUD_HOME/role-switches.json and allow it in this project`, 'role_unavailable');
    seats.set(name, { preset: name, place });
  }
  const instructions = role.instructions ?? 'oracle', source = configured.get(instructions);
  if (!source || source.optionalEnabled === false) return invalid(`Instructions role ${instructions} is unavailable`, 'role_unavailable');
  const chosen = members.map(name => seats.get(name)!);
  const name = source.instructions ?? source.role;
  if ([...seats.values()].some(s => s.place.harness === 'cli') && (!plainSkillName(name) || !existsSync(join(bundled, 'instructions', `${name}.md`))))
    return invalid(`Missing CLI instructions for ${instructions}`, 'role_unavailable');
  let browserInstructions: string | undefined;
  if (chosen.some(seat => seat.place.harness === 'bro')) {
    try {
      if (!plainSkillName(name)) throw new Error();
      const file = readFileBounded(join(bundled, 'instructions', `${name}.md`), 64 * 1024);
      if (file.truncated) throw new Error();
      browserInstructions = file.bytes.toString('utf8');
    } catch { return invalid(`Browser member cannot read instructions for ${instructions}`, 'role_unavailable'); }
  }
  return { members: chosen, synthesizer: synthesizer === 'main' ? 'main' : seats.get(synthesizer as string)!, instructions, browserInstructions };
}

const memberInstruction = 'Write an independent plan for the original brief. Do not implement changes or delegate. Put open questions in your report.';
type Start = (seat: CouncilSeat, part: 'member' | 'synthesizer', args: Args, slot: string) => Promise<{ job?: string; failure?: string }>;

/** Snapshot the final report privately so collecting or archiving either job is independent. */
async function publishSynthesis(dir: string, child: string, signal: AbortSignal) {
  const src = await open(join(directory(child), jobFiles.report), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const tmp = join(dir, `.synthesis-${randomUUID()}.tmp`);
  try {
    if (!(await src.stat()).isFile()) throw new Error('synthesis report is not a file');
    await pipeline(src.createReadStream({ autoClose: false }), createWriteStream(tmp, { flags: 'wx', mode: 0o600 }), { signal });
    await rename(tmp, join(dir, jobFiles.report));
  } finally { await src.close(); await rm(tmp, { force: true }); }
}

export async function runCouncil(parent: Job, plan: CouncilPlan, task: string, start: Start, signal: AbortSignal, releaseUnused: () => Promise<void>) {
  const dir = directory(parent.job), members = parent.council_members!;
  const wait = (job: string) => waitChildReport(job, async child => {
    const { closeJob } = await import('../mcp/operations.js');
    return closeJob(child, true);
  }, { signal });
  try {
    const browser = plan.members.some(s => s.place.harness === 'bro') || (plan.synthesizer !== 'main' && plan.synthesizer.place.harness === 'bro');
    const index = browser ? await councilIndex(parent) : '';
    // Account for every launch before deciding that no member spent the reservation.
    const outcomes = await Promise.allSettled(plan.members.map(async (seat, i) => {
      const member = members[i];
      try {
        if (member.failure || member.digest !== undefined) return;
        const local = seat.place.harness !== 'bro';
        const result = member.job ? { job: member.job } : await start(seat, 'member', {
          task: `${local ? '' : plan.browserInstructions + '\n\n'}${memberInstruction}\n\nOriginal brief:\n${task}${local ? '' : index}`,
          ...(local && { instructions: plan.instructions, context_files: parent.context_files, from_jobs: parent.from_jobs }),
        }, `member-${i}`);
        member.job = result.job;
        save(parent);
        member.failure = result.failure ?? (result.job && await wait(result.job));
        if (result.job && !member.failure) {
          const dir = directory(result.job);
          member.digest = readReportMeta(dir)?.summary ?? fallbackResultLine(readFileBounded(join(dir, jobFiles.report), RESULT_HEAD_BYTES).bytes.toString('utf8'));
        }
      } catch (error) { member.failure = String(error); }
      if (member.failure) member.failure = digestLine(member.failure, 400);
      save(parent);
    }));
    const rejected = outcomes.find(outcome => outcome.status === 'rejected');
    if (rejected) throw rejected.reason;
    signal.throwIfAborted();
    const reports = members.flatMap(m => m.job && !m.failure ? [m.job] : []);
    const roster = members.map((m, i) => `Member ${i + 1} (${m.preset}${m.job ? `, ${m.job}` : ''}): ${m.failure ? `failed — ${m.failure}` : 'report available'}`).join('\n');
    if (reports.length < 2) throw new Error(`Fewer than two member reports. ${roster}`);
    const prompt = `${synthesisTemplate}\n\nOriginal brief:\n${task}\n\n${roster}`;
    if (plan.synthesizer === 'main') writePrivateFile(join(dir, jobFiles.report), prompt);
    else {
      const local = plan.synthesizer.place.harness !== 'bro';
      const result = parent.synthesis_job ? { job: parent.synthesis_job } : await start(plan.synthesizer, 'synthesizer', { task: prompt + (local ? '' : index), from_jobs: reports,
        ...(local && { context_files: parent.context_files, instructions: plan.instructions }) }, 'synthesis');
      parent.synthesis_job = result.job;
      save(parent);
      if (!result.job || result.failure) throw new Error(result.failure ?? 'synthesis did not start');
      const failure = await wait(result.job);
      if (failure) throw new Error(`Synthesis failed: ${failure}`);
      await publishSynthesis(dir, result.job, signal);
    }
    signal.throwIfAborted();
    const now = new Date().toISOString();
    if (readCachedStatus(parent.job).status?.state !== 'closed') {
      writeCreateStatus(dir, { state: 'closed', output_written: true, settled_at: now, ended_at: now });
    }
    return { state: 'closed' as const };
  } catch (error) {
    if (!parent.grant) await releaseUnused();
    const reason = signal.aborted ? 'Council stopped' : error instanceof Error ? error.message : String(error);
    const state = signal.aborted ? 'stopped' : 'failed';
    writeCreateStatus(dir, { state, exit_reason: reason, ended_at: new Date().toISOString() });
    return { state, exit_reason: reason } as const;
  }
}
