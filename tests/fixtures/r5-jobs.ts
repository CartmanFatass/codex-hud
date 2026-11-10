/** Synthetic exact on-disk producer formats for R5, in a private temporary HUD_HOME. */
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { associationPath, writeAssociation, type JobAssociation } from '../../src/roles/association.js';
import { writePrivate } from '../../src/roles/job-store.js';
import { JobObservationCollector } from '../../src/collectors/job-observations.js';
import { composeJobTree } from '../../src/collectors/job-tree.js';
import type { SubagentTree } from '../../src/types.js';
import type { JobReceipt } from '../../src/roles/job-receipt.js';
import type { JobSnapshot } from '../../src/collectors/job-display-types.js';

export const FIXED_R5_NOW = Date.parse('2026-11-09T12:00:00Z');
export const ROOT_R5 = 'synthetic/main';
export const refR5 = (source = 'a', sessionId = 'synthetic-native') => ({
  harness: 'codex' as const,
  sourceId: source.repeat(64),
  sessionId,
  threadId: null,
});
export const idR5 = (n: number) => `j${n.toString(16).padStart(16, '0')}`;
export function r5Fixture(t: TestContext) {
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hud-r5-')));
  fs.chmodSync(home, 0o700);
  let now = FIXED_R5_NOW;
  let listing = JSON.stringify({
    result: { agents: [{ name: 'synthetic-agent', tab_id: 'tab-1', pane_id: 'pane-1', agent_status: 'working' }] },
  });
  let calls = 0;
  const observers: JobObservationCollector[] = [];
  const observer = (
    root: string | null = ROOT_R5,
    process = {
      alive: (_pid: number) => true,
      cmdline: (_pid: number) => '/synthetic/node\0/synthetic/dist/jev/runtime/entry.js\0',
    }
  ) => {
    const c = new JobObservationCollector(home, {
      root,
      now: () => now,
      herdr: async () => {
        calls++;
        return listing;
      },
      process,
    });
    observers.push(c);
    return c;
  };
  t.after(() => {
    for (const c of observers) c.dispose();
    fs.rmSync(home, { recursive: true, force: true });
  });
  // These producers use file mtimes as evidence dates. Keep disk evidence on the
  // same clock as the observer, including replacements after advance().
  const stamp = (file: string) => fs.utimesSync(file, new Date(now), new Date(now));
  const put = (file: string, value: unknown) => {
    writePrivate(file, typeof value === 'string' ? value : JSON.stringify(value) + '\n');
    stamp(file);
  };
  const association = (n: number, patch: Partial<JobAssociation> = {}): JobAssociation => {
    const a: JobAssociation = {
      schema: 1,
      job: idR5(n),
      root: ROOT_R5,
      role: 'imp',
      phase: null,
      preset: 'launch-preset',
      task_label: 'Synthetic task',
      cwd: '/synthetic/work',
      backend: {
        id: 'synthetic-cli',
        executor: 'herdr',
        harness: 'pi',
        model: 'launch-model',
        effort: 'high',
        env_profile: null,
        recipe: 'pi-role',
      },
      herdr: { tab_id: 'tab-1', pane_id: 'pane-1', agent: 'synthetic-agent', workspace_id: null },
      report_path: join(home, 'jobs', idR5(n), 'report.md'),
      closed: false,
      ...patch,
    };
    writeAssociation(home, a);
    stamp(associationPath(home, a.job));
    return a;
  };
  const receipt = (a: JobAssociation, patch: Partial<JobReceipt> = {}): JobReceipt => {
    // src/roles/facade.ts saveReceipt/associationOf: no exported receipt writer; writePrivate is its real atomic writer.
    const r: JobReceipt = {
      schema: 1,
      job: a.job,
      parent: a.root,
      request_key: 'synthetic-key',
      fingerprint: 'synthetic-fingerprint',
      role: a.role,
      phase: a.phase,
      routing_revision: 'synthetic-revision',
      preset: a.preset,
      jev_decisions: { id: 'synthetic-decision', provider: 'typesafe', model: 'decision-model' },
      binding: {
        ...a.backend,
        harness: a.backend.harness as 'pi' | null,
        target: null,
        mode: null,
        args: {},
        wrapper: null,
        capabilities: [],
      },
      cwd: a.cwd,
      task_label: a.task_label,
      label: 'synthetic-label',
      state: 'open',
      launch_error: null,
      prompted: true,
      steps: { tab_create: 'acked', launch: 'acked', rename: 'unsent', prompt: 'acked', tab_closed: false },
      executor:
        a.backend.executor === 'herdr'
          ? { kind: 'herdr', ...a.herdr, agent: a.herdr.agent ?? '' }
          : { kind: 'jev', job: `runtime-${a.job}` },
      closed_observation: null,
      ...patch,
    };
    put(join(home, 'jobs', a.job, 'receipt.json'), r);
    fs.mkdirSync(join(home, 'jobs', a.job, 'qa'), { recursive: true, mode: 0o700 });
    return r;
  };
  const status = (a: JobAssociation, state = 'working', patch: Record<string, unknown> = {}, slot = 'primary') => {
    const directory = join(home, 'jobs', a.job);
    // pi-roles STATUS v1 contract mirrored by src/roles/pi-dispatch-status.ts snapshot.
    const raw = {
      version: 1,
      task_dir: directory,
      slot,
      role: slot === 'primary' ? 'implementer' : slot.startsWith('review-') ? 'reviewer' : slot.split('-')[0],
      model: 'observed-model',
      thinking: 'max',
      session_id: `synthetic-${slot}`,
      output_path: join(directory, slot === 'primary' ? 'report.md' : `${slot}.md`),
      output_written: false,
      state,
      helper_pending: null,
      started_at: '2026-11-09T00:00:00Z',
      settled_at: null,
      idle_deadline_at: null,
      ended_at: null,
      exit_reason: null,
      error: null,
      updated_at: '2026-11-09T00:00:00Z',
      ...patch,
    };
    put(slot === 'primary' ? join(directory, 'STATUS.json') : join(directory, '.dispatch', slot, 'STATUS.json'), raw);
  };
  const dispatch = (a: JobAssociation, state = 'working', patch: Record<string, unknown> = {}) => {
    const r = receipt(a, {
      pi_dispatch: {
        contract_version: 1,
        role: 'implementer',
        executable: '/synthetic/pi-dispatch',
        reaper: '/synthetic/pi-role-reap',
        launch: 'acked',
      },
    });
    status(a, state, patch);
    return r;
  };
  const jev = (
    a: JobAssociation,
    state = 'running',
    result: unknown = null,
    closed = false,
    patch: Record<string, unknown> = {}
  ) => {
    const r = receipt(a);
    // src/jev/runtime/executor.ts StoredJob + writeFile; its writer is private, never instantiate an executor here.
    put(join(home, 'jev-runtime', 'jobs', `${r.executor.kind === 'jev' ? r.executor.job : ''}.json`), {
      executor: 'jev',
      id: `runtime-${a.job}`,
      requestKey: 'synthetic-key',
      fingerprint: 'synthetic-fingerprint',
      session: { namespace: a.root.split('/')[0], sessionId: a.root.split('/')[1] },
      tag: 'ask',
      input: { tag: 'ask', target: 'chatgpt-pro', label: 'synthetic', prompt: 'Synthetic only' },
      decisionProfile: 'synthetic-decision',
      provider: { id: 'typesafe', model: 'decision-model' },
      state,
      closed,
      seq: 1,
      result,
      createdAt: '2026-11-09T00:00:00Z',
      phase: 'wait',
      run: { startedAt: '2026-11-09T00:00:00Z', ...(closed ? { endedAt: '2026-11-09T00:01:00Z' } : {}) },
      ...patch,
    });
    // src/jev/runtime/executor.ts writeRuntimeFile.
    put(join(home, 'jev-runtime', 'runtime.json'), { pid: 12345, startedAt: '2026-11-09T00:00:00Z' });
  };
  const emptyTree = (): SubagentTree => ({ rootId: 'main', nodes: [], totalCount: 0, updatedAt: new Date(now) });
  const collect = async (c: JobObservationCollector, ticks = 10, tree = emptyTree()) => {
    let snapshot: JobSnapshot = await c.refresh();
    await c.live.settled();
    for (let n = 1; n < ticks; n++) snapshot = await c.refresh();
    return { snapshot, ...composeJobTree({ tree, snapshot, root: ROOT_R5, nowMs: now }) };
  };
  return {
    home,
    put,
    association,
    receipt,
    status,
    dispatch,
    jev,
    observer,
    emptyTree,
    collect,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    list: (text: string) => {
      listing = text;
    },
    calls: () => calls,
  };
}
