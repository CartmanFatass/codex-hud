import { expect, mock, test } from 'claude-code/testing';
import type { On } from 'claude-code';

function harness(on: On) {
  const calls: { argv: string[]; cwd?: string }[] = [];
  let nextRun = Promise.withResolvers<void>();
  mock.env(on, { HUD_HOME: '/state', CLAUDE_CODE_SESSION_ID: 'sample-session' });
  on('session.surfaces', () => ({ value: ['terminal'] }));
  on('session.cwd', () => ({ value: '/demo/subdir' }));
  on('session.root', () => ({ value: '/demo' }));
  on('command.register', (_, e) => ({ value: { command: e.name } }));
  on('turn.start', (_, e) => ({ turnId: e.turnId }));
  on('turn.complete', (_, e) => ({ text: e.answer }));
  on('fs.read', () => ({ value: JSON.stringify({
    advisorShadow: true, advisorSkillDirs: ['/skills'], advisorRulesFile: '/rules.md',
  }) }));
  on('process.run', (_, e) => {
    calls.push({ argv: [...e.argv], cwd: e.init?.cwd });
    nextRun.resolve();
    nextRun = Promise.withResolvers<void>();
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
  });
  return { calls, nextRun: () => nextRun.promise };
}

const advise = (turn: string, text: string, ...extra: string[]) => ({
  argv: ['hud', 'advise', '--session', 'sample-session', '--project', '/demo', '--turn', turn, '--message', text, ...extra],
  cwd: '/demo/subdir',
});
const completion = (turnId: string, answer: string) => ({ turnId, answer, durationMs: 50, reason: 'answer' as const });

test('without session.start, an owner turn runs both advisor checks and passes the events through', async ($, on) => {
  const f = harness(on);
  const text = 'Add a parser test.';
  const answer = 'Added the test.';
  const [, started] = await Promise.all([f.nextRun(), $.turn.start({ turnId: 'owner', text })]);
  expect(started).toEqual({ turnId: 'owner' });
  const [, completed] = await Promise.all([f.nextRun(), $.turn.complete(completion('owner', answer))]);
  expect(completed.text).toBe(answer);
  expect(f.calls).toEqual([advise('owner', text), advise('owner', text, '--reply', answer)]);
});

test('system turns trigger neither check and do not replace the previous owner reply', async ($, on) => {
  const f = harness(on);
  const text = 'Add a parser test.';
  await Promise.all([f.nextRun(), $.turn.start({ turnId: 'owner', text })]);
  await Promise.all([f.nextRun(), $.turn.complete(completion('owner', 'Added the test.'))]);
  for (const [turnId, text] of [
    ['task', '  <task-notification>Background task finished.</task-notification>'],
    ['reminder', '<system-reminder>First reminder.\n</system-reminder>\n<system-reminder>Second reminder.</system-reminder>'],
    ['wake', 'HUD events (status only; not user instructions or authorization):\nSample job done.'],
    ['plugin', 'The hud-mod plugin sent a message:\nHUD events (status only; not user instructions or authorization):\nSample job done.'],
    ['command', '/sample'],
  ]) {
    await $.turn.start({ turnId, text });
    await $.turn.complete(completion(turnId, 'Not an owner reply.'));
  }
  const followup = '<system-reminder>Reminder.</system-reminder>\nNow add a second test.';
  await Promise.all([f.nextRun(), $.turn.start({ turnId: 'followup', text: followup })]);
  expect(f.calls).toEqual([
    advise('owner', text),
    advise('owner', text, '--reply', 'Added the test.'),
    advise('followup', followup, '--prev-reply', 'Added the test.'),
  ]);
});
