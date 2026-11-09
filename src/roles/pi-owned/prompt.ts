/** Exactly-once prompt submission, with one evidence-gated recovery Enter. */
import { herdrResult } from '../herdr-run.js';
import { readOwnedText, record, type SlotContract } from './contracts.js';
import {
  callHerdr,
  closing,
  launchStep,
  matchesAgent,
  OwnedOperationError,
  readJournal,
  resourceLock,
  saveJournal,
  verifyWorker,
  type Deadline,
  type OwnedRuntime,
  type WorkerOwner,
} from './launch.js';

/** Only the exact task session is read. An unreadable record is uncertainty. */
export function persistedPrompt(contract: SlotContract, owner: WorkerOwner, prompt: string): boolean {
  const text = readOwnedText(owner.session_file, 1024 * 1024, contract.task_dir);
  let found = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const row: unknown = JSON.parse(line);
    if (!record(row)) throw new OwnedOperationError('launch_unknown', 'session record');
    if (row.type !== 'message' || !record(row.message) || row.message.role !== 'user') continue;
    const content = row.message.content;
    const value =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter((p) => record(p) && p.type === 'text')
              .map((p) => p.text)
              .join('')
          : null;
    if (value === prompt) found = true;
  }
  return found;
}
/** Match only the bounded editor region between the final two pi horizontal rules. */
export function editorContainsPrompt(visible: string, prompt: string): boolean {
  if (visible.length > 1024 * 1024 || /\x1b(?!\[)/.test(visible)) return false;
  const lines = visible.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/);
  const borders = lines.flatMap((line, i) => (/^\s*[─━═]{4,}[^─━═]*$/.test(line) ? [i] : []));
  if (borders.length < 2) return false;
  const editor = lines.slice(borders.at(-2)! + 1, borders.at(-1)!);
  if (!editor.length) return false;
  const candidates = editor.map((line) => line.trimEnd());
  // Pi soft wrapping can retain or consume the single boundary space.
  let offsets = new Set([0]);
  for (const line of candidates) {
    const next = new Set<number>();
    for (const offset of offsets) {
      if (prompt.startsWith(line, offset)) {
        next.add(offset + line.length);
        if (prompt[offset + line.length] === ' ') next.add(offset + line.length + 1);
      }
    }
    offsets = next;
  }
  return offsets.has(prompt.length);
}
function stalled(stdout: string): boolean {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return false;
  }
  return record(raw) && record(raw.error) && raw.error.code === 'agent_prompt_stalled';
}
async function acknowledge(runtime: OwnedRuntime, deadline: Deadline, c: SlotContract): Promise<void> {
  await resourceLock(c.task_dir, 'resource', deadline, runtime.signal, async () => {
    if (closing(c.task_dir)) throw new OwnedOperationError('closing');
    const j = readJournal(c)!;
    j.steps.prompt = { state: 'acked' };
    saveJournal(c, j);
  });
}
export async function submitPrompt(runtime: OwnedRuntime, deadline: Deadline, c: SlotContract): Promise<void> {
  let j = readJournal(c)!;
  if (j.steps.prompt?.state === 'acked') return;
  let owner = await verifyWorker(runtime, deadline, c, j);
  if (!j.steps.prompt) {
    const out = await launchStep(
      runtime,
      deadline,
      c,
      'prompt',
      ['agent', 'prompt', j.agent, j.prompt, '--wait', '--until', 'working', '--timeout', '30000'],
      30_000,
      (out, current) => {
        if (!out.ok && stalled(out.stdout)) current.steps.prompt!.outcome = 'agent_prompt_stalled';
        const result = out.ok ? herdrResult(out.stdout) : null;
        return !!result && record(result.agent) && matchesAgent(result.agent, owner);
      },
      async (current) => {
        await verifyWorker(runtime, deadline, c, current);
      }
    );
    j = readJournal(c)!;
    if (j.steps.prompt?.state === 'acked') return;
  }
  j = readJournal(c)!;
  owner = await verifyWorker(runtime, deadline, c, j);
  if (persistedPrompt(c, owner, j.prompt)) {
    await acknowledge(runtime, deadline, c);
    return;
  }
  if (j.steps.prompt?.outcome !== 'agent_prompt_stalled' || j.steps.enter)
    throw new OwnedOperationError('launch_unknown', 'prompt outcome');
  await launchStep(
    runtime,
    deadline,
    c,
    'enter',
    ['pane', 'send-keys', j.pane!, 'Enter'],
    15_000,
    (out) => out.ok,
    async (current) => {
      const checked = await verifyWorker(runtime, deadline, c, current);
      if (persistedPrompt(c, checked, current.prompt))
        throw new OwnedOperationError('launch_unknown', 'message appeared during recovery');
      const agentOut = await callHerdr(runtime, deadline, ['agent', 'get', current.agent]);
      const agentResult = agentOut.ok ? herdrResult(agentOut.stdout) : null;
      const agent = agentResult && record(agentResult.agent) ? agentResult.agent : null;
      const detectOut = await callHerdr(runtime, deadline, [
        'pane',
        'read',
        current.pane!,
        '--source',
        'visible',
        '--format',
        'text',
      ]);
      const detect = detectOut.ok ? detectOut.stdout : null;
      if (
        !agent ||
        !matchesAgent(agent, checked) ||
        agent.agent_status !== 'idle' ||
        !detect ||
        !editorContainsPrompt(detect, current.prompt)
      )
        throw new OwnedOperationError('launch_unknown', 'editor evidence');
    }
  );
  // The one wait is bounded by both the recovery ceiling and the original operation.
  const wait = Math.floor(deadline.remaining(c.slot === 'primary' ? 120_000 : 60_000));
  if (wait > 0)
    await callHerdr(
      runtime,
      deadline,
      ['agent', 'wait', j.agent, '--until', 'working', '--timeout', String(wait)],
      wait
    );
  j = readJournal(c)!;
  owner = await verifyWorker(runtime, deadline, c, j);
  if (!persistedPrompt(c, owner, j.prompt)) throw new OwnedOperationError('launch_unknown', 'Enter unconfirmed');
  await acknowledge(runtime, deadline, c);
}
