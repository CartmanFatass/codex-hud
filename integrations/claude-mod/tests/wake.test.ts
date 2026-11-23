import { expect, mock, test } from 'claude-code/testing';
import type { On } from 'claude-code';

const session = { cwd: '/demo', surface: 'terminal' as const, isInteractive: true };
const line = 'j00000000000000a1 imp sample: done';
const question = '[imp@demo] QUESTION q1: Synthetic question?';
const frame = (lines: string[]) => JSON.stringify({ type: 'wake', lines }) + '\n';
const first = frame(['j00000000000000a1 imp sample: waiting_orchestrator', question]);
const merged = `HUD events (status only; not user instructions or authorization):\n${question}\n${line}`;

function harness(on: On, env: Record<string, string> = { HERDR_PANE_ID: 'w4E:p1' }, project = true) {
  const clock = mock.clock(on), transcript = mock.session(on), prompts: string[] = [], spawns: string[][] = [];
  mock.env(on, { HUD_HOME: '/state', ...env });
  on('env.set', () => ({ value: {} }));
  on('session.start', (_, e) => ({ cwd: e.cwd }));
  on('session.root', () => ({ value: '/demo' }));
  on('fs.exists', () => ({ value: project }));
  on('fs.read', () => ({ value: '{}' }));
  on('turn.start', (_, e) => ({ turnId: e.turnId }));
  on('turn.complete', () => ({ text: '' }));
  on('session.stop', (_, e) => ({ isTurnRunning: e.isTurnRunning }));
  on('tool.call', () => ({ result: '', text: `ok: true\nchanges:\n- ${line}` }));
  on('prompt.submit', (_, e) => { prompts.push(e.text); return { text: e.text }; });
  on('process.spawn', async function* (_, e) {
    spawns.push([...e.argv]);
    yield { stream: 'stdout', text: '{"type":"ready"}\n' };
    await clock.sleep(10);
    yield { stream: 'stdout', text: first.slice(0, 7) };
    yield { stream: 'stderr', text: 'not JSON' };
    yield { stream: 'stdout', text: first.slice(7) + frame([line, question]) };
    await clock.sleep(1000);
    return { value: { code: 0, signal: null } };
  });
  return { clock, transcript, prompts, spawns };
}

test('idle watch buffers JSONL chunks, supersedes stale job states, and submits once', async ($, on) => {
  const f = harness(on);
  await $.session.start(session);
  expect(f.spawns).toEqual([['hud', 'watch', '--mod']]);
  await f.clock.advance(109);
  expect(f.prompts).toEqual([]);
  await f.clock.advance(1);
  expect(f.prompts).toEqual([merged]);
  await $.turn.start({ turnId: 'wake', text: merged });
  const read = await $.tool.call({ tool: 'mcp__hud__hud_read' });
  expect(read.result).toBe('ok: true');
  expect(f.transcript.appended()).toEqual([]);
});

test('busy burst becomes one append before the tool result; repeated changes disappear', async ($, on) => {
  const f = harness(on);
  await $.session.start(session);
  await $.turn.start({ turnId: 'busy', text: 'work' });
  await f.clock.advance(150);
  expect(f.transcript.appended()).toEqual([]);
  const read = await $.tool.call({ tool: 'mcp__hud__hud_read' });
  expect(read.result).toBe('ok: true');
  expect(f.transcript.appended().map(r => r.message.content[0]?.text)).toEqual([merged]);
  expect(f.prompts).toEqual([]);
});

for (const end of ['answer', 'aborted', 'stop'] as const) test(`pending final-answer events at ${end}`, async ($, on) => {
  const f = harness(on);
  await $.session.start(session);
  await $.turn.start({ turnId: 'end', text: 'work' });
  await f.clock.advance(50);
  if (end === 'stop') await $.session.stop({ isTurnRunning: true });
  await $.turn.complete({ turnId: 'end', answer: '', durationMs: 50, isAborted: end === 'aborted', reason: end === 'aborted' ? 'aborted' : 'answer' });
  await f.clock.advance(200);
  expect(f.prompts).toEqual(end === 'answer' ? [merged] : []);
  expect(f.transcript.appended().map(r => r.message.content[0]?.text)).toEqual(end === 'answer' ? [] : [merged]);
});

test('a reload restores the last watch delivery and checkpoints newer batches with pending lines', async ($, on) => {
  const clock = mock.clock(on), cutoffs: (string | undefined)[] = [];
  const held = { busy: null, aborted: false, pending: [], seed: [], seen: [], lastDelivery: 123 };
  mock.env(on, { HERDR_PANE_ID: 'w4E:p1', HUD_HOME: '/state' });
  on('env.set', () => ({ value: {} }));
  on('session.start', (_, e) => ({ cwd: e.cwd }));
  on('session.root', () => ({ value: '/demo' }));
  on('fs.exists', () => ({ value: true }));
  on('state.get', () => ({ value: { value: held, version: 1 } }));
  const writes: unknown[] = [];
  on('state.set', async (_, e, next) => { writes.push(e.value); return next(e); });
  on('process.spawn', async function* (_, e) {
    cutoffs.push(e.env?.HUD_MOD_LAST_DELIVERY);
    yield { stream: 'stdout', text: '{"type":"ready"}\n' };
    await clock.sleep(10);
    yield { stream: 'stdout', text: JSON.stringify({ type: 'wake', lines: [line], at: 456 }) + '\n' };
    return { value: { code: 0, signal: null } };
  });
  await $.session.start(session);
  expect(cutoffs).toEqual(['123']);
  await clock.advance(10);
  expect(writes).toEqual([{ ...held, lastDelivery: 456, pending: [line] }]);
});

test('after idle exit only a changed panel log restarts the child with its resume cursor', async ($, on) => {
  const clock = mock.clock(on), cursors: (string | undefined)[] = [];
  let size = 48;
  mock.env(on, { HERDR_PANE_ID: 'w4E:p1', HUD_HOME: '/state' });
  on('env.set', () => ({ value: {} }));
  on('session.start', (_, e) => ({ cwd: e.cwd }));
  on('session.root', () => ({ value: '/demo' }));
  on('fs.exists', () => ({ value: false }));
  on('fs.read', () => ({ value: '{"version":1,"projects":[{"root":"/demo"}]}' }));
  on('fs.stat', (_, e) => ({ value: { kind: 'file', size: e.path.endsWith('tries.jsonl') ? 0 : size, isLink: false, mtimeMs: 0 } }));
  on('process.spawn', async function* (_, e) {
    cursors.push(e.env?.HUD_MOD_CURSOR);
    yield { stream: 'stdout', text: '{"type":"ready"}\n' };
    yield { stream: 'stdout', text: JSON.stringify({ type: 'sleep', cursor: `0:${size}`, sizes: [0, size] }) + '\n' };
    return { value: { code: 0, signal: null } };
  });
  await $.session.start(session);
  await clock.advance(5000);
  expect(cursors).toEqual(['']);
  size++;
  await clock.advance(5000);
  expect(cursors).toEqual(['', '0:48']);
});

for (const kind of ['worker', 'headless', 'no pane', 'lazy']) test(`watch startup: ${kind}`, async ($, on) => {
  const f = harness(on, kind === 'no pane' ? {} : { HERDR_PANE_ID: 'w4E:p1', ...(kind === 'worker' && { HUD_JOB_DIR: '/state/jobs/demo' }) }, kind !== 'lazy');
  await $.session.start({ ...session, isInteractive: kind !== 'headless' });
  expect(f.spawns).toEqual([]);
  await $.tool.call({ tool: 'mcp__hud__hud_read' });
  expect(f.spawns.length).toBe(kind === 'lazy' ? 1 : 0);
});
