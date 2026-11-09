/** Single submission and the sole permitted recovery: one journalled Enter. */
import { herdrResult } from '../herdr-run.js';
import { readOwnedText, record, type SlotContract } from './contracts.js';
import { ExecutionError, type Journal, type Owner, type Runtime } from './runtime.js';

export function persistedPrompt(contract: SlotContract, owner: Owner, prompt: string): boolean {
  const lines = readOwnedText(owner.session_file, 1024 * 1024, contract.task_dir)
    .split('\n')
    .filter(Boolean);
  for (const line of lines) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new ExecutionError('session_unknown');
    }
    if (!record(raw) || raw.type !== 'message' || !record(raw.message) || raw.message.role !== 'user') continue;
    const content = raw.message.content;
    if (
      content === prompt ||
      (Array.isArray(content) &&
        content.length === 1 &&
        record(content[0]) &&
        content[0].type === 'text' &&
        content[0].text === prompt)
    )
      return true;
  }
  return false;
}
/** Pi's editor is between the final two horizontal rules. Never search transcript prose. */
export function editorHasPrompt(screen: string, prompt: string): boolean {
  if (Buffer.byteLength(screen) > 128 * 1024 || /\x1b/.test(screen)) return false;
  const lines = screen.split('\n');
  const rules = lines.flatMap((line, n) => (/^[─━-]{3,}\s*$/.test(line) ? [n] : []));
  if (rules.length < 2) return false;
  const start = rules[rules.length - 2]!;
  const end = rules[rules.length - 1]!;
  // Only remove evidenced display line breaks. Spaces within the original prompt
  // (especially its path) are data; ambiguous padding or altered spaces refuse Enter.
  return lines.slice(start + 1, end).join('') === prompt;
}
function errorCode(stdout: string): string | null {
  const result = herdrResult(stdout);
  return result && record(result.error) && typeof result.error.code === 'string' ? result.error.code : null;
}
export async function submitPrompt(runtime: Runtime, contract: SlotContract, journal: Journal): Promise<void> {
  const prompt = `Read ${contract.brief_path} and do exactly what it asks.`;
  if (journal.steps.prompt?.state === 'acked') return;
  let owner = await runtime.owner(contract, journal);
  if (journal.steps.prompt?.state === 'sent') {
    if (persistedPrompt(contract, owner, prompt)) {
      journal.steps.prompt = { state: 'acked' };
      runtime.writeJournal(journal);
      return;
    }
    if (journal.steps.prompt.result?.error_code !== 'agent_prompt_stalled') throw new ExecutionError('launch_unknown');
  } else {
    await runtime.admitted(async () => {
      await runtime.tab(journal);
      owner = await runtime.owner(contract, journal);
      journal.steps.prompt = { state: 'intent' };
      runtime.writeJournal(journal);
      journal.steps.prompt = { state: 'sent' };
      runtime.writeJournal(journal);
      const out = await runtime.call(
        ['agent', 'prompt', journal.name, prompt, '--wait', '--until', 'working', '--timeout', '30000'],
        30_000
      );
      if (out.ok && herdrResult(out.stdout)) {
        journal.steps.prompt = { state: 'acked' };
        runtime.writeJournal(journal);
        return;
      }
      if (errorCode(out.stdout) !== 'agent_prompt_stalled') throw new ExecutionError('launch_unknown');
      journal.steps.prompt.result = { error_code: 'agent_prompt_stalled' };
      runtime.writeJournal(journal);
    });
    if (runtime.journal(contract.slot)?.steps.prompt?.state === 'acked') return;
  }
  owner = await runtime.owner(contract, journal);
  if (persistedPrompt(contract, owner, prompt)) {
    journal.steps.prompt = { state: 'acked' };
    runtime.writeJournal(journal);
    return;
  }
  // Even an unacknowledged Enter can have reached the server. Never send another.
  if (journal.steps.enter?.state === 'sent' || journal.steps.enter?.state === 'acked')
    throw new ExecutionError('launch_unknown');
  await runtime.effect(journal, 'enter', ['pane', 'send-keys', journal.pane!, 'Enter'], 15_000, async () => {
    await runtime.tab(journal);
    await runtime.owner(contract, journal);
    const agent = (await runtime.query(['agent', 'get', journal.name])).agent;
    if (!record(agent) || agent.agent_status !== 'idle') throw new ExecutionError('launch_unknown');
    const screen = await runtime.call(['pane', 'read', journal.pane!, '--source', 'detection', '--lines', '200']);
    if (!screen.ok || !editorHasPrompt(screen.stdout, prompt)) throw new ExecutionError('launch_unknown');
  });
  const waitMs = Math.floor(runtime.deadline.remaining(contract.slot === 'primary' ? 120_000 : 60_000));
  const out = await runtime.call(
    ['agent', 'wait', journal.name, '--until', 'working', '--timeout', String(waitMs)],
    waitMs
  );
  if (!out.ok) throw new ExecutionError('launch_unknown');
  await runtime.owner(contract, journal);
  journal.steps.prompt = { state: 'acked' };
  runtime.writeJournal(journal);
}
