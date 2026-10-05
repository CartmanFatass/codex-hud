/**
 * The brief exactly as the panel would send it now, written out instead of
 * sent (`codex-hud brief --dry-run`): to see what leaves the machine, and as
 * a check on the material. No model is called and nothing is written: the
 * session is found and read as the panel reads it, with the settings, the
 * agent log and the stored recap as they are on disk, and as a panel just
 * opened would, it counts as news what came after the newest note (or the
 * stored recap).
 */
import * as path from 'node:path';
import { SessionFinder } from './session-finder.js';
import { RolloutParser } from './rollout.js';
import { buildSubagentTree, useTreeScanStore } from './subagent-tree.js';
import { TreeScanStore } from './tree-scan-store.js';
import { AgentLog } from './agent-log.js';
import { RecapStore } from './recap.js';
import { SmallModel } from './small-model.js';
import { ModelJobs, NO_JOBS } from './model-jobs.js';
import { briefMaterial, lastNoteAt, REPORT_BYTES } from './briefing.js';
import { codexGoal } from './codex-goal.js';
import { briefingScope, type HudSettings } from '../settings.js';
import { resolveLanguage } from '../render/i18n.js';
import { roleSet } from '../render/directions.js';

export interface DryRunOptions {
  /** The directory whose Codex session is read, as the panel's. */
  cwd: string;
  settings: HudSettings;
  codexHome: string;
  /** The HUD's own state: the agent log, the recaps, the labels. */
  hudHome: string;
  now?: number;
}

const kb = (text: string) => `${(Buffer.byteLength(text, 'utf8') / 1024).toFixed(1)} KB`;

/** The brief's instructions and prompt as they would go now, under a header; or why there is none. */
export async function dryRunText(options: DryRunOptions): Promise<{ text: string } | { error: string }> {
  const { settings } = options;
  const now = options.now ?? Date.now();
  const session = new SessionFinder(options.cwd).check();
  if (!session) return { error: `No Codex session found for ${options.cwd}` };
  const parser = new RolloutParser(40);
  parser.setRolloutPath(session.path);
  const main = await parser.parse();
  const rootId = main?.session?.id ?? session.sessionId ?? '';
  if (!rootId) return { error: `The session at ${session.path} has no id yet` };
  // The panel's saved scans spare a read of every rollout from its start; none is written.
  useTreeScanStore(new TreeScanStore(path.join(options.hudHome, 'scan'), { readOnly: true, now }));
  const tree = buildSubagentTree(rootId, main?.subagents ?? []);
  useTreeScanStore(undefined);
  const language = resolveLanguage(settings.language);
  // Read, never flushed: the log on disk stays as it is.
  const log = new AgentLog(path.join(options.hudHome, 'agent-log'));
  log.observe(tree);
  // The digests already written stand in for answers, as in the panel once a backend is chosen.
  // Nothing is asked for: apply only reads, and the model is never configured (off, no cache).
  new ModelJobs({ model: new SmallModel(), log }).apply(tree, { ...NO_JOBS, resultDigest: settings.resultDigest }, language);
  const chosen = briefingScope(settings);
  const scope = chosen ?? 'agents';
  const recap = scope !== 'agents' ? new RecapStore(path.join(options.hudHome, 'recaps')).load(rootId) : null;
  const logs = log.snapshot();
  const material = briefMaterial(tree, { scope, language, main, recap, logs,
    roles: roleSet(settings.importantRoles), goal: scope !== 'agents' ? codexGoal(options.codexHome, rootId, now) : null,
    since: recap?.at ?? lastNoteAt(tree, logs), overall: recap?.overall, now });
  if (!material) return { error: 'Nothing to brief yet: no agents, and nothing said in the main session' };
  const { system, prompt } = material.write();
  const notes = [
    `# codex-hud brief --dry-run: what the panel would send now. Nothing was sent.`,
    `# session ${rootId}, scope ${scope}, language ${language}, backend ${settings.briefing}`,
    ...(settings.briefing === 'off' ? ['# The brief is off in Settings: this is what it would send once a backend is chosen.'] : []),
    ...(chosen ? [] : ['# Neither Agents brief nor Main recap is on in Settings: shown with Agents brief.']),
    `# instructions ${kb(system)}, material ${kb(prompt)}, ${kb(system + prompt)} in all (budget ${REPORT_BYTES / 1024} KB)`,
  ];
  return { text: `${notes.join('\n')}\n\n=== instructions ===\n${system}\n\n=== material ===\n${prompt}\n` };
}
