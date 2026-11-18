/** The Project hub with long waiting items and unlisted worktrees, all synthetic: STATE written to disk, worktrees linked in Git. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { projectFixture, NOW } from './project-page.mjs';

export const WAITING = [
  'Try 0.2 PANEL-TIDY: open the Project tab; every waiting item shows its whole text and Now lists only work in flight; then say whether the bars read.',
  'Try the synthetic setup, then reopen `/hud` in a Claude pane and check the lines come back.',
  'Choose the browser profile for the synthetic flow',
  'Decide whether the hub keeps its Latest block on a short panel, and say so in this file when you have.',
];
const LEDGER = [
  '- working · 0.2 · NATIVE-TREE · native subagents on Home, one lane per main session',
  '- try · 0.2 · LANDING · a landed slice (1234567)',
  '- accepted · 0.2 · SHIPPED · an accepted slice (2345678)',
  '- accepted · 0.2 · SHIPPED-TWO · another accepted slice (3456789)',
  '- todo · 0.2 · QUEUE · a later slice',
];

/** A waiting bullet with continuation lines, as STATE wraps them: a sentence that flows on, then numbered checks. */
export const TRY_LONG = 'Try 0.3 PANEL-NEXT, a synthetic try with several checks, each of which the owner reads to its end:\n'
  + '  open the Project hub, then press Enter on this item.\n'
  + '  1. The whole text opens on a page of its own, continuation lines and all.\n'
  + '  2. Scroll it with the arrow keys or the wheel; the last check is further down than the first rows show.\n'
  + '  3. Press Esc: the hub comes back with the cursor on this very item, not on the first one.';
/** `idle`: no slice in flight and no job, so Now is empty; the unlisted worktrees stay (NO-JOB and two more). `waiting`: STATE's waiting bullets (a bullet may have continuation lines). */
export async function hubFixture(root, { idle = false, waiting = WAITING } = {}) {
  const f = await projectFixture(root);
  const state = join(f.cwd, 'docs/handoff/STATE.md');
  const ledger = (idle ? LEDGER.slice(1) : LEDGER).join('\n');
  f.put(state, `# State\n\nMilestone: 0.2 · Panel tidy\n\n## Waiting for the owner\n\n${waiting.map((w) => `- ${w}`).join('\n')}\n\n## Slices\n\n${ledger}\n\n## Now (2026-11-17): Synthetic tidy\n`);
  for (const name of ['EXTRA-ONE', 'EXTRA-TWO']) {
    const path = join(root, name), admin = join(f.cwd, '.git/worktrees', name);
    f.put(join(path, '.git'), `gitdir: ${admin}\n`);
    f.put(join(admin, 'gitdir'), join(path, '.git') + '\n');
    f.put(join(admin, 'commondir'), '../..\n');
    f.put(join(admin, 'HEAD'), `ref: refs/heads/wt/${name}\n`);
    f.put(join(f.cwd, '.git/refs/heads/wt', name), fs.readFileSync(join(f.cwd, '.git/refs/heads/wt/NO-JOB'), 'utf8'));
  }
  let board = f.board;
  if (idle) {
    fs.rmSync(join(f.hud, 'jobs'), { recursive: true, force: true });
    fs.rmSync(join(f.cwd, '.git/worktrees/NATIVE-TREE'), { recursive: true, force: true });
    board = { ...board, lanes: [], workers: [] };
  }
  const data = await new ProjectCollector(f.cwd, f.hud, f.env, f.home).collect(true, board, NOW);
  // The same render as the project fixture's, on this data and board.
  const render = (width, lang, state, height, extra, icons = 'unicode') => f.render(width, lang, state, height, data, true, icons, 'none', { workboard: board, ...extra });
  return { ...f, data, board, render };
}
