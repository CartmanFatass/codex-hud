/** Herdr tabs for panel commands and explicit worker actions. */
import * as fs from 'node:fs';
import { basename, join } from 'node:path';
import { binScript, jobFiles } from '../mcp/paths.js';
import { readJsonFile } from '../utils/atomic-fs.js';
import { truncateAnsi } from '../render/colors.js';
import { runHerdr, runCommand, herdrResult, isRecord, herdrId } from '../roles/herdr-run.js';
import { stopSonic } from '../mcp/sonic-process.js';
import { recordStopOrigin } from '../roles/job-archive.js';
import { fileStampOf } from '../roles/job-index-cache.js';
import { reapWorkerTree, tabTreeGrant } from '../roles/worker-tree.js';
import { removeQueuedJob } from '../roles/concurrency.js';
import { OBJECTIVE_HASH } from '../collectors/objectives.js';
import { hasHerdrHiddenTabs, hasHerdrHiddenTabsPeek, herdrEndpoint, request as herdrRequest } from '../runtime/herdr-socket.js';

async function command(argv: string[], env: NodeJS.ProcessEnv) {
  const result = env.HERDR_DOCK === '1' && env.HERDR_BIN_PATH
    ? await runCommand(env.HERDR_BIN_PATH, argv, env) : await runHerdr(argv, env);
  if (!result.ok) throw Error(`herdr_${result.reason}`);
  return herdrResult(result.stdout);
}

async function openCommandPane(cwd: string, label: string, shell: string, env: NodeJS.ProcessEnv): Promise<void> {
  const docked = env.HERDR_DOCK === '1';
  const ownPane = env.HERDR_PANE_ID;
  if (!docked && !herdrId(ownPane)) throw Error('panel_requires_herdr');
  // The dock has no workspace identity. An unscoped tab.create uses the active workspace.
  const panel = !docked && ownPane ? await command(['pane', 'get', ownPane], env).catch(() => null) : null;
  const workspace = isRecord(panel?.pane) ? panel.pane.workspace_id : undefined;
  const result = await command(['tab', 'create', ...(herdrId(workspace) ? ['--workspace', workspace] : []),
    '--cwd', cwd, '--label', truncateAnsi(label, 24), ...(docked ? [] : ['--focus'])], env);
  const pane = isRecord(result?.root_pane) ? result.root_pane.pane_id : undefined;
  if (!herdrId(pane)) throw Error('panel_tab_unknown');
  if (docked) {
    // tab.create --focus switches the active tab but leaves keyboard focus in the dock.
    const tab = isRecord(result?.tab) ? result.tab.tab_id : undefined;
    if (!herdrId(tab)) throw Error('panel_tab_unknown');
    await command(['tab', 'focus', tab], env);
  }
  await command(['pane', 'run', pane, shell], env);
}

export async function openEditorPane(files: string[], env: NodeJS.ProcessEnv): Promise<void> {
  if (!files.length) return;
  const paths = files.map((file) => `'${file.replaceAll("'", "'\\''")}'`).join(' ');
  await openCommandPane(process.cwd(), basename(files[0]), `${env.EDITOR || 'vim'} ${paths}; exit`, env);
}

export async function openGitShowPane(cwd: string, hash: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (!OBJECTIVE_HASH.test(hash)) throw Error('invalid_commit_hash');
  // The pager is chosen here, not by repository configuration. Don't run external diffs or fetch missing objects.
  // Leave the tab open so errors or unpaged output are still readable.
  await openCommandPane(cwd, hash,
    `env GIT_PAGER=less GIT_NO_LAZY_FETCH=1 git -c protocol.allow=never -c pager.show=true show --no-ext-diff --no-textconv ${hash} --`, env);
}

/** Explicit Inspector and Execution actions, addressed to the worker's recorded tab, not the active tab. */
async function jobTabAction(jobDir: string, env: NodeJS.ProcessEnv, mode: 'focus' | 'pin' | 'hide'): Promise<{ ok: boolean; reason?: string }> {
  let lines: string[];
  try { lines = fs.readFileSync(join(jobDir, jobFiles.session), 'utf8').split('\n'); }
  catch { return { ok: false, reason: 'no tab' }; }
  const field = (key: string) => lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);
  const tab = field('TAB');
  if (!herdrId(tab)) return { ok: false, reason: 'no tab' };
  if (field('DIRECT_EXEC') !== '1') {
    if (mode !== 'focus') return { ok: false, reason: mode === 'pin' ? 'tab pinning unavailable' : 'hidden tabs unavailable' };
    const result = await runHerdr(['tab', 'focus', tab], env, { budgetMs: 5000 });
    return result.ok ? { ok: true } : { ok: false, reason: result.reason === 'failed' ? 'tab closed' : result.reason };
  }
  const endpoint = herdrEndpoint(env), launchId = field('LAUNCH_ID');
  if (!endpoint || endpoint !== field('HERDR_SOCKET_PATH') || !herdrId(launchId)) return { ok: false, reason: 'unavailable' };
  if (mode === 'hide' && !(await hasHerdrHiddenTabs(env))) return { ok: false, reason: 'hidden tabs unavailable' };
  if (mode === 'pin' && !(await hasHerdrHiddenTabsPeek(env))) return { ok: false, reason: 'tab pinning unavailable' };
  const target = { tab_id: tab };
  const got = await herdrRequest('tab.get', target, { env });
  if (got?.error?.code === 'tab_not_found') return { ok: false, reason: 'tab closed' };
  const found = got?.result?.tab;
  if (!found || found.tab_id !== tab || !found.launch_id) return { ok: false, reason: 'unavailable' };
  if (found.launch_id !== launchId) return { ok: false, reason: 'tab closed' }; // The public ID can be reused.
  const updated = await (mode === 'focus' ? herdrRequest('tab.focus', target, { env })
    : herdrRequest('tab.set_hidden', { ...target, hidden: mode === 'hide' }, { env }));
  if (updated?.error?.code === 'tab_not_found') return { ok: false, reason: 'tab closed' };
  return updated?.result?.tab?.launch_id === launchId ? { ok: true } : { ok: false, reason: 'unavailable' };
}

export const focusJobTab = (dir: string, env: NodeJS.ProcessEnv) => jobTabAction(dir, env, 'focus');
export const pinJobTab = (dir: string, env: NodeJS.ProcessEnv) => jobTabAction(dir, env, 'pin');
export const hideJobTab = (dir: string, env: NodeJS.ProcessEnv) => jobTabAction(dir, env, 'hide');

const readJson = (file: string): Record<string, unknown> | null => {
  try {
    const value = readJsonFile(file);
    return isRecord(value) ? value : null;
  } catch { return null; }
};
function readSessionLaunch(jobDir: string): { stamp: string; launchStamp: string } | null {
  try {
    const path = join(jobDir, jobFiles.session);
    const st = fs.lstatSync(path, { bigint: true });
    if (!st.isFile()) return null;
    const stamp = fileStampOf(st);
    const lines = fs.readFileSync(path, 'utf8').split('\n');
    const field = (key: string) => lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);
    const launchId = field('LAUNCH_ID');
    const launch = field('LAUNCH');
    const launchStamp = (launchId && herdrId(launchId) ? launchId : undefined)
      ?? (launch && herdrId(launch) ? launch : undefined)
      ?? `stamp:${stamp}`;
    return { stamp, launchStamp };
  } catch { return null; }
}
/** Stop a HUD job as `hud_close` does: a CLI job already in its idle grace is asked to quit, then `hud-reap` reaps it. */
export async function stopJob(jobDir: string, env: NodeJS.ProcessEnv): Promise<{ ok: boolean; reason?: string }> {
  const status = readJson(join(jobDir, 'STATUS.json'));
  try {
    const job = readJson(join(jobDir, jobFiles.job));
    if (!job?.headless && job?.reaped_at) return { ok: true };
    const outcome = removeQueuedJob(jobDir, status?.state);
    if (outcome === 'cancelled' || outcome === 'missing') return { ok: true };
    recordStopOrigin(jobDir, 'panel', status?.state);
    if (readJson(join(jobDir, jobFiles.job))?.headless) return await stopSonic(jobDir) ? { ok: true } : { ok: false, reason: 'headless worker cleanup pending' };
    const initialSession = readSessionLaunch(jobDir);
    const { result, complete, issue } = await reapWorkerTree(jobDir, status, () => {
      const currentSession = readSessionLaunch(jobDir);
      const sameLaunch = !initialSession || currentSession?.stamp === initialSession.stamp;
      if (sameLaunch && isRecord(readJson(join(jobDir, 'job.json'))?.cli) && status?.state === 'idle_grace') {
        try { fs.writeFileSync(join(jobDir, jobFiles.closeRequested), '', { flag: 'wx', mode: 0o600 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      const reapArgs = [binScript('hud-reap'), jobDir, ...(initialSession?.launchStamp ? ['--launch', initialSession.launchStamp] : [])];
      return runCommand(process.execPath, reapArgs, env, { budgetMs: 60_000, killProcessGroup: true });
    }, (run) => run.ok, { treeGrant: tabTreeGrant });
    return complete ? { ok: true } : { ok: false, reason: issue ?? (result.reason === 'unavailable' ? 'hud-reap missing' : 'reap failed') };
  } catch { return { ok: false, reason: 'reap failed' }; }
}
