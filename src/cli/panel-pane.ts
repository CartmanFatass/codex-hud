/** Simple local herdr pane operations shared by the CLI and pi package. */
import * as fs from 'node:fs';
import { basename, join } from 'node:path';
import { binScript, jobFiles } from '../mcp/paths.js';
import { readJsonFile } from '../utils/atomic-fs.js';
import { loadSettings } from '../settings.js';
import { panelWidth, DEFAULT_WIDTH } from '../utils/pane-width.js';
import { truncateAnsi } from '../render/colors.js';
import { runHerdr, runCommand, herdrResult, isRecord, herdrId } from '../roles/herdr-run.js';
import { stopSonic } from '../mcp/sonic-process.js';
import { recordStopOrigin } from '../roles/job-archive.js';
import { fileStampOf } from '../roles/job-index-cache.js';
import { reapWorkerTree, tabTreeGrant } from '../roles/worker-tree.js';
import { removeQueuedJob } from '../roles/concurrency.js';
import { OBJECTIVE_HASH } from '../collectors/objectives.js';
import { hasHerdrHiddenTabs, herdrEndpoint, request as herdrRequest } from '../runtime/herdr-socket.js';

async function command(argv: string[], env: NodeJS.ProcessEnv) {
  const result = await runHerdr(argv, env);
  if (!result.ok) throw Error(`herdr_${result.reason}`);
  return herdrResult(result.stdout);
}

async function openCommandPane(cwd: string, label: string, shell: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (!herdrId(env.HERDR_PANE_ID)) throw Error('panel_requires_herdr');
  const panel = await command(['pane', 'get', env.HERDR_PANE_ID], env).catch(() => null);
  const workspace = isRecord(panel?.pane) ? panel.pane.workspace_id : undefined;
  const inTab = herdrId(workspace);
  const result = await command(
    inTab
      ? [
          'tab', 'create', '--workspace', workspace, '--cwd', cwd,
          '--label', truncateAnsi(label, 24), '--focus',
        ]
      : ['pane', 'split', env.HERDR_PANE_ID, '--direction', 'right', '--focus', '--cwd', cwd],
    env
  );
  const root = inTab ? result?.root_pane : result?.pane;
  const pane = isRecord(root) ? root.pane_id : undefined;
  if (!herdrId(pane)) throw Error(inTab ? 'panel_tab_unknown' : 'panel_split_unknown');
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

/** Explicit Inspector actions, addressed to the worker's recorded tab, not the active tab. */
async function jobTabAction(jobDir: string, env: NodeJS.ProcessEnv, hide: boolean): Promise<{ ok: boolean; reason?: string }> {
  let lines: string[];
  try { lines = fs.readFileSync(join(jobDir, jobFiles.session), 'utf8').split('\n'); }
  catch { return { ok: false, reason: 'no tab' }; }
  const field = (key: string) => lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);
  const tab = field('TAB');
  if (!herdrId(tab)) return { ok: false, reason: 'no tab' };
  if (field('DIRECT_EXEC') !== '1') {
    if (hide) return { ok: false, reason: 'hidden tabs unavailable' };
    const result = await runHerdr(['tab', 'focus', tab], env, { budgetMs: 5000 });
    return result.ok ? { ok: true } : { ok: false, reason: result.reason === 'failed' ? 'tab closed' : result.reason };
  }
  const endpoint = herdrEndpoint(env), launchId = field('LAUNCH_ID');
  if (!endpoint || endpoint !== field('HERDR_SOCKET_PATH') || !herdrId(launchId)) return { ok: false, reason: 'unavailable' };
  if (hide && !(await hasHerdrHiddenTabs(env))) return { ok: false, reason: 'hidden tabs unavailable' };
  const target = { tab_id: tab };
  const got = await herdrRequest('tab.get', target, { env });
  if (got?.error?.code === 'tab_not_found') return { ok: false, reason: 'tab closed' };
  const found = got?.result?.tab;
  if (!found || found.tab_id !== tab || !found.launch_id) return { ok: false, reason: 'unavailable' };
  if (found.launch_id !== launchId) return { ok: false, reason: 'tab closed' }; // The public ID can be reused.
  const updated = await (hide ? herdrRequest('tab.set_hidden', { ...target, hidden: true }, { env })
    : herdrRequest('tab.focus', target, { env }));
  if (updated?.error?.code === 'tab_not_found') return { ok: false, reason: 'tab closed' };
  return updated?.result?.tab?.launch_id === launchId ? { ok: true } : { ok: false, reason: 'unavailable' };
}

export const focusJobTab = (dir: string, env: NodeJS.ProcessEnv) => jobTabAction(dir, env, false);
export const hideJobTab = (dir: string, env: NodeJS.ProcessEnv) => jobTabAction(dir, env, true);

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

export async function closePanelPane(pane: string, env: NodeJS.ProcessEnv): Promise<void> {
  await command(['pane', 'close', pane], env);
}

export async function panelPaneExists(pane: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const result = await runHerdr(['pane', 'get', pane], env);
  return result.ok && isRecord(herdrResult(result.stdout)?.pane);
}

/** Only an authoritative missing-pane reply ends the panel, not a failed transport. */
export function watchPanelCaller(env: NodeJS.ProcessEnv, onMissing: () => void): () => void {
  const caller = env.HUD_PANEL_CALLER_PANE;
  if (!herdrId(caller) || !herdrId(env.HERDR_PANE_ID) || caller === env.HERDR_PANE_ID) return () => {};
  const abort = new AbortController();
  // Test-only caller probe interval override.
  const ms = Number(env.HUD_PANEL_CALLER_POLL_MS);
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void runHerdr(['pane', 'get', caller], env, { budgetMs: 1000, signal: abort.signal })
      .then((result) => {
        if (abort.signal.aborted) return;
        if (result.reason === 'unavailable') clearInterval(timer);
        const error = herdrResult(result.stderr)?.error;
        if (result.reason === 'failed' && isRecord(error) && error.code === 'not_found') {
          clearInterval(timer);
          onMissing();
        }
      })
      .finally(() => { busy = false; });
  }, Number.isInteger(ms) && ms > 0 ? ms : 3000);
  return () => {
    clearInterval(timer);
    abort.abort();
  };
}

export async function openPanelPane(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  width = (() => { try { return loadSettings(env).treeWidth; } catch { return DEFAULT_WIDTH; } })(),
  columns = process.stdout.isTTY ? process.stdout.columns : Number(env.COLUMNS)
): Promise<string> {
  if (!herdrId(env.HERDR_PANE_ID)) throw Error('panel_requires_herdr');
  if (!Number.isFinite(columns) || columns <= 0) {
    const layout = await command(['pane', 'layout', '--pane', env.HERDR_PANE_ID], env).catch(() => null);
    const panes = isRecord(layout?.layout) ? layout.layout.panes : null;
    const caller = Array.isArray(panes) ? panes.find((p) => p.pane_id === env.HERDR_PANE_ID) : null;
    columns = isRecord(caller?.rect) ? Number(caller.rect.width) : NaN;
    if (!Number.isFinite(columns) || columns <= 0) columns = 120;
  }
  const requested = width;
  width = panelWidth(width, columns);
  const result = await command(
    [
      'pane',
      'split',
      env.HERDR_PANE_ID,
      '--direction',
      'right',
      '--ratio',
      String(Math.max(0.1, Math.min(0.9, 1 - width / columns))),
      '--no-focus',
      '--cwd',
      cwd,
      '--env',
      `HUD_PANEL_CALLER_PANE=${env.HERDR_PANE_ID}`,
      '--env',
      `HUD_PANEL_WIDTH=${requested}`,
    ],
    env
  );
  const pane = isRecord(result?.pane) ? result.pane.pane_id : undefined;
  if (!herdrId(pane)) throw Error('panel_split_unknown');
  try {
    await command(['pane', 'rename', pane, 'hud panel'], env);
    const text = argv.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(' ');
    await command(['pane', 'run', pane, text], env);
    return pane;
  } catch (error) {
    await closePanelPane(pane, env).catch(() => {});
    throw error;
  }
}
