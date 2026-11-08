// R4 restart matrix: persisted snapshots model the four process-crash windows.
// Every filesystem path/credential/page is synthetic and private to the test.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { operationPath } from '../../src/jev/ask/names.js';
import { squashedSha256 } from '../../src/jev/ask/records.js';
import { studioKey } from '../../src/jev/runtime/aistudio-state.js';
import { JevRuntime, askRecordKey } from '../../src/jev/runtime/executor.js';
import { fakeProvider } from '../../src/jev/runtime/fake.js';
import type { OracleFacts, OraclePage, OracleTarget } from '../../src/jev/runtime/oracle.js';
import type { JevJob } from '../../src/jev/runtime/types.js';

const session = { namespace: 'synthetic', sessionId: 'r4-restart' };
const prompt = 'synthetic restart question';
const answer = 'synthetic final answer';
const url = 'https://oracle.example/settled';
function fixture(targetId: 'chatgpt-pro' | 'aistudio') {
  let clicks = 0;
  let opens = 0;
  let clock = 1_700_000_000_000;
  const facts: OracleFacts = {
    url,
    readyState: 'complete',
    marker: 'stable',
    composer: null,
    stop: false,
    sidebar: [],
    cards: [],
    turns: [
      { role: 'user', text: prompt },
      { role: 'assistant', text: answer, final_controls: true },
    ],
    ...(targetId === 'aistudio' ? { exchange: { users: 1, text: answer, final: true } } : {}),
  };
  const page: OraclePage = {
    id: 'observer',
    async facts() {
      return facts;
    },
    async observation() {
      return {
        page: { url, title: '', text: '' },
        elements: [],
        facts: { readyState: 'complete', marker: 'stable' },
        deltas: {},
      };
    },
    async close() {},
    async detach() {},
  };
  const target: OracleTarget = {
    provider: targetId === 'aistudio' ? 'aistudio' : 'chatgpt',
    root: 'https://oracle.example/',
    settled(value): value is string {
      return value === url;
    },
    async open() {
      opens++;
      return page;
    },
    async attach() {
      opens++;
      return page;
    },
    async targets() {
      return [{ targetId: 'send', url }];
    },
    async prepare() {
      throw new Error('recovery_must_not_prepare');
    },
    async click() {
      clicks++;
      throw new Error('recovery_must_not_click');
    },
    binding() {
      return { found: true, answer, final: true };
    },
    matchesDraft() {
      return false;
    },
  };
  return {
    target,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    clicks: () => clicks,
    opens: () => opens,
  };
}
for (const targetId of ['chatgpt-pro', 'aistudio'] as const) {
  for (const provider of ['typesafe', 'openai'] as const) {
    for (const window of [
      'before_attempt',
      'after_attempt_before_click_result',
      'after_confirm',
      'during_wait',
    ] as const) {
      test(`R4 ${targetId}/${provider}: restart ${window} only reconciles/observes`, async (t) => {
        const home = mkdtempSync(join(tmpdir(), 'r4-recovery-'));
        t.after(() => rmSync(home, { recursive: true, force: true }));
        const stateDir = join(home, 'state');
        mkdirSync(stateDir, { mode: 0o700 });
        writeFileSync(
          join(home, 'jev.env'),
          'TYPESAFE_API_KEY=synthetic-r4-key\nOPENAI_API_KEY=synthetic-r4-openai\n',
          { mode: 0o600 }
        );
        const jobs = join(home, 'jev-runtime', 'jobs');
        mkdirSync(jobs, { recursive: true, mode: 0o700 });
        const key =
          targetId === 'chatgpt-pro'
            ? askRecordKey('chatgpt-pro', 'restart', prompt)
            : studioKey('restart', prompt, 'fixture-model', 'High', 'new');
        const input = {
          tag: 'ask',
          target: targetId,
          label: 'restart',
          prompt,
          model: 'fixture-model',
          thinking: 'High',
          maxWaitMs: 60_000,
        };
        writeFileSync(
          join(jobs, 'jev-crashed.json'),
          JSON.stringify({
            executor: 'jev',
            id: 'jev-crashed',
            requestKey: 'crashed',
            fingerprint: 'fixture',
            session,
            tag: 'ask',
            input,
            decisionProfile: null,
            provider: { id: provider, model: 'fixture' },
            state: 'running',
            closed: false,
            seq: 4,
            result: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            run: { startedAt: '2026-01-01T00:00:00.000Z' },
            ...(targetId === 'aistudio' ? { askStateDir: stateDir } : {}),
          }),
          { mode: 0o600 }
        );
        if (window !== 'before_attempt') {
          const record = {
            key,
            provider: targetId === 'chatgpt-pro' ? 'chatgpt' : 'aistudio',
            send_attempted: true,
            send_effect: window === 'after_attempt_before_click_result' ? 'uncertain' : 'sent',
            squashed_sha256: squashedSha256(prompt),
            sent_target_id: 'send',
            sidebar_before: [],
            before: { url: 'https://oracle.example/', turns: [], sidebar: [] },
            ...(window !== 'after_attempt_before_click_result' ? { conversation_url: url } : {}),
            ...(window === 'during_wait'
              ? { partial_answer_chars: 7, tabs: { observer: 'stale-observer', sent: 'send' } }
              : {}),
            ...(targetId === 'aistudio'
              ? { attempted_at: '2026-01-01T00:00:00+00:00', user_turn: 1, status: 'interrupted' }
              : {}),
          };
          if (targetId === 'chatgpt-pro') {
            mkdirSync(join(stateDir, 'operations'), { mode: 0o700 });
            writeFileSync(operationPath(stateDir, key), JSON.stringify(record), { mode: 0o600 });
          } else
            writeFileSync(
              join(stateDir, 'aistudio_chat_state.json'),
              JSON.stringify({ keys: { [key]: record }, unknown_cli_field: 'preserved' }),
              { mode: 0o600 }
            );
        }
        const h = fixture(targetId);
        const runtime = new JevRuntime({
          hudHome: home,
          stateDir,
          fake: true,
          graceMs: 60_000,
          providerFactory: () => ({ ...fakeProvider(), id: provider }),
          oracleTargets: { [targetId]: h.target },
          oracleNow: h.now,
          oracleSleep: h.sleep,
          studioConfigLoader: () => ({ stateDir, models: ['fixture-model'], model: 'fixture-model', thinking: 'High' }),
        });
        await runtime.start();
        t.after(() => runtime.stop());
        const plain = await runtime.readJob('jev-crashed');
        assert.equal(plain.state, 'interrupted');
        assert.equal(h.opens(), 0);
        await Promise.all([
          runtime.readJob('jev-crashed', { resume: true }),
          runtime.readJob('jev-crashed', { resume: true }),
        ]);
        if (window === 'before_attempt') {
          assert.equal((await runtime.readJob('jev-crashed')).state, 'interrupted');
          assert.equal(h.opens(), 0);
        } else {
          let done: JevJob = await runtime.readJob('jev-crashed');
          for (let poll = 0; poll < 200 && done.state === 'running'; poll++) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            done = await runtime.readJob('jev-crashed');
          }
          assert.equal(done.state, 'completed', JSON.stringify(done));
          assert.equal((done.result as { status: string }).status, 'answered');
          assert.equal((done.result as { answer: string }).answer, answer);
          const closed = await runtime.closeJob('jev-crashed');
          assert.deepEqual(closed.result, done.result);
          if (targetId === 'aistudio')
            assert.equal(
              JSON.parse(readFileSync(join(stateDir, 'aistudio_chat_state.json'), 'utf8')).unknown_cli_field,
              'preserved'
            );
        }
        assert.equal(h.clicks(), 0, 'a restart must never repeat Send');
      });
    }
  }
}
