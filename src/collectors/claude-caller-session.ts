/** Read-only display selection, resolved in the caller before any panel split. */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { opendirSync, realpathSync, statSync } from 'node:fs';
import { runHerdr, herdrResult, isRecord, herdrId } from '../roles/herdr-run.js';

export async function claudeCallerSession(
  env: NodeJS.ProcessEnv, herdr = runHerdr
): Promise<{ session: string; source: string } | undefined> {
  if (!herdrId(env.HERDR_PANE_ID)) return;
  try {
    const reply = await herdr(['pane', 'current'], env, { budgetMs: 1000 });
    const pane = reply.ok ? herdrResult(reply.stdout)?.pane : null;
    if (!isRecord(pane) || pane.agent !== 'claude' || !isRecord(pane.agent_session)) return;
    const session = pane.agent_session.value;
    if (pane.agent_session.kind !== 'id' || typeof session !== 'string' ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(session)) return;
    const projects = join(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude'), 'projects');
    const probe = (name: string) => {
      try {
        const source = join(projects, name);
        if (statSync(join(source, session + '.jsonl')).isFile()) return { session, source: realpathSync(source) };
      } catch {
        /* Try the next project, never descend into it. */
      }
    };
    const direct = typeof pane.cwd === 'string' ? probe(pane.cwd.replace(/[/.]/g, '-')) : undefined;
    if (direct) return direct;
    const directory = opendirSync(projects);
    try {
      for (let n = 0; n < 256; n++) {
        const entry = directory.readSync();
        if (!entry) break;
        const found = entry.isDirectory() ? probe(entry.name) : undefined;
        if (found) return found;
      }
    } finally {
      directory.closeSync();
    }
  } catch {
    /* Missing herdr/transcript: keep the unbound all-jobs panel. */
  }
}
