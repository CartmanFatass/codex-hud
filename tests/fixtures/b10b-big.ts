/**
 * The 200-node synthetic tree the B10b benches share (the segment 1 bench's shape), every time shifted by `shift`
 * seconds. Deterministic; synthetic data only.
 */

import { NOW, S, ago, buildVm, type Built, type NodeSpec, type StatusSpec } from './b10b-delegation.js';

export { NOW, S, ago, type Built };

export function bigTree(shift = 0, tweak?: { id: string; status: StatusSpec }): Built {
  const t = (s: number) => ago(s + shift);
  const specs: NodeSpec[] = [
    {
      id: 'main',
      root: true,
      harness: 'claude',
      status: S.working(t(300)),
      label: null,
      model: 'fable-5.1',
      effort: 'high',
      contextPercent: 41,
    },
  ];
  const harnesses = ['codex', 'pi', 'codex', 'claude'] as const;
  const ids: string[] = ['main'];
  for (let i = 1; i < 200; i++) {
    const id = `n${String(i).padStart(3, '0')}`;
    const parent = i % 6 === 0 && ids.length > 6 ? ids[1 + ((i * 7) % (ids.length - 1))] : 'main';
    const kind = i % 17;
    const native = i % 9 === 0 && parent !== 'main';
    const status: StatusSpec =
      tweak && tweak.id === id
        ? tweak.status
        : kind === 3
          ? S.pending('approval', t(5 + i))
          : kind === 8
            ? S.stale(t(40 + i), t(40 + i))
            : kind === 11
              ? S.failed(t(30 + (i % 100)))
              : kind >= 13
                ? S.exited(t(20 + (i % 100)))
                : S.working(t(100 + i));
    const finished = kind >= 13 || kind === 11;
    specs.push({
      id,
      parent,
      harness: harnesses[i % harnesses.length],
      label: native ? null : `worker-${id}`,
      role: 'implementer',
      native,
      ...(native ? { nativeMeta: { title: `native-${id}`, kind: i % 2 ? 'review' : 'research' } } : {}),
      status,
      run: native
        ? false
        : finished
          ? {
              state: kind === 11 ? 'failed' : 'ended',
              mode: i % 3 ? 'headless' : 'visible',
              endedAt: t(20 + (i % 100)),
            }
          : { state: 'running', mode: i % 3 ? 'headless' : 'visible' },
      report:
        finished && !native
          ? {
              status: kind === 11 ? 'failed' : 'completed',
              summary: `Finished ${id} with a short synthetic summary.`,
              at: t(20 + (i % 100)),
            }
          : null,
      model: 'gpt-6.1-sol',
      effort: i % 2 ? 'high' : 'xhigh',
      contextPercent: (i * 7) % 100,
      costUsd: i % 5 === 0 ? null : 0.01 * i,
      createdAt: t(3000 - i),
      pane: i % 3 === 0 ? `pane ${i % 9}` : undefined,
    });
    ids.push(id);
  }
  return buildVm(specs, { capacity: { active: 6, limit: 6, mine: 4, mineLimit: 4 } });
}
