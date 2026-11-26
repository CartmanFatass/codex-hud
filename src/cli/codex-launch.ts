import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { getHudHome } from '../hud-home.js';
import { herdrId } from '../roles/herdr-run.js';
import {
  clearPaneStrip,
  herdrEndpoint,
  probeHerdrPaneStrip,
  setPaneStrip,
} from '../runtime/herdr-socket.js';
import { reportMainPaneGroup } from '../runtime/pane-group.js';
import { loadSettings } from '../settings.js';
import { snapshotPath } from '../snapshot.js';
import { BAR_RELOAD_EXIT_CODE, STRIP_LEASE_MS } from '../strip-bar.js';
import { installationRoot } from './compat.js';

const HERDR_CONTEXT_KEYS = [
  'HERDR_ENV',
  'HERDR_WORKSPACE_ID',
  'HERDR_TAB_ID',
  'HERDR_PANE_ID',
  'HERDR_SESSION',
  'HERDR_SOCKET',
  'HERDR_SOCKET_PATH',
  'HERDR_CONFIG_PATH',
] as const;

const CODEX_HUD_HELP = `codex-hud - Codex CLI with HUD display on the herdr pane strip

Usage: codex-hud [options] [codex options...]

Launches Codex directly inside the current herdr pane with a one-line status
bar pushed to herdr's bottom pane strip (requires the herdr-hud fork with
pane_strip support). Mouse selection, scrollback and shortcuts belong directly
to the herdr pane.

All other arguments are passed through to the codex command.

Options:
  -h, --help          Show this help message
  --self-check        Run environment and herdr-hud pane_strip diagnostics
  --json              Print this pane's recorded HUD state as JSON
  brief --dry-run     Inspect a delegation brief without launching

Environment Variables:
  HUD_STATUSLINE / CODEX_HUD_STATUSLINE
                      Bottom HUD strip: 1 on (default), 0 off (wins over Settings)
  CODEX_HOME          Codex account home (default: ~/.codex)
  HUD_HOME            HUD state home (default: ~/.hud)

Requirements:
  - herdr-hud fork with pane_strip capability
  - Node.js 24+
  - Codex CLI
`;

export function parseBooleanEnv(name: string, raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw === '') return defaultValue;
  switch (raw.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'on':
    case 'yes':
      return true;
    case '0':
    case 'false':
    case 'off':
    case 'no':
      return false;
    default:
      throw new Error(`${name} must be one of: 1, 0, true, false, on, off, yes, no (got: ${raw})`);
  }
}

export function resolveStatuslineEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (Object.hasOwn(env, 'HUD_STATUSLINE')) {
    return parseBooleanEnv('HUD_STATUSLINE', env.HUD_STATUSLINE, true);
  }
  if (env.CODEX_HUD_STATUSLINE !== undefined && env.CODEX_HUD_STATUSLINE !== '') {
    return parseBooleanEnv('CODEX_HUD_STATUSLINE', env.CODEX_HUD_STATUSLINE, true);
  }
  try {
    return loadSettings(env).statusline;
  } catch {
    return true;
  }
}

export function resolveCodexCli(env: NodeJS.ProcessEnv = process.env, wrapperPath?: string): string {
  const pathEnv = env.PATH ?? '';
  let resolvedWrapper: string | null = null;
  if (wrapperPath) {
    try {
      resolvedWrapper = fs.realpathSync(wrapperPath);
    } catch {
      resolvedWrapper = path.resolve(wrapperPath);
    }
  }
  for (const entry of pathEnv.split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, 'codex');
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      const real = fs.realpathSync(candidate);
      if (resolvedWrapper && real === resolvedWrapper) {
        throw new Error('codex resolves to codex-hud wrapper. Fix your alias to point to the real codex CLI.');
      }
      return candidate;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('codex resolves to')) throw error;
    }
  }
  throw new Error('codex CLI is not found in PATH.\n\nInstall Codex CLI from: https://github.com/openai/codex');
}

/**
 * Pass this pane's Herdr context and CODEX_HOME via Codex `-c` overrides so the
 * TUI's shell tools do not inherit another pane's identity from a shared daemon.
 */
export function buildCodexCommand(
  codexPath: string,
  codexArgs: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const inside = env.HERDR_ENV === '1';
  const overrides: string[] = [];
  for (const key of HERDR_CONTEXT_KEYS) {
    const value = inside ? (env[key] ?? '') : '';
    overrides.push('-c', `shell_environment_policy.set.${key}=${JSON.stringify(value)}`);
  }
  if (env.CODEX_HOME) {
    overrides.push('-c', `shell_environment_policy.set.CODEX_HOME=${JSON.stringify(env.CODEX_HOME)}`);
  }
  return [codexPath, ...overrides, ...codexArgs];
}

function initialStripLine(env: NodeJS.ProcessEnv): string {
  const text = ' codex-hud · reading session…';
  if ((env.NO_COLOR ?? '') !== '') return text;
  return `\x1b[2m${text}\x1b[0m`;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
      resolve();
    }, timeoutMs);
    timer.unref();
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function runSelfCheck(env: NodeJS.ProcessEnv, hudDir: string, stdout: (s: string) => void, stderr: (s: string) => void): Promise<number> {
  let failures = 0;
  stdout('Codex HUD self-check\n\n');
  try {
    const codexPath = resolveCodexCli(env, path.join(hudDir, 'bin/codex-hud'));
    stdout(`Info: codex: ${codexPath}\n`);
  } catch (error) {
    stderr(`Warning: ${(error as Error).message.split('\n')[0]}\n`);
    failures++;
  }
  stdout(`Info: node ${process.version}\n`);

  const endpoint = herdrEndpoint(env);
  const paneId = env.HERDR_PANE_ID;
  if (env.HERDR_ENV !== '1' || !endpoint || !herdrId(paneId)) {
    stderr('Warning: not running inside a herdr pane (HERDR_ENV/HERDR_SOCKET_PATH/HERDR_PANE_ID missing); pane_strip unavailable.\n');
    failures++;
  } else {
    const probe = await probeHerdrPaneStrip(env);
    if (!probe.reachable) {
      stderr(`Warning: herdr socket not reachable at ${endpoint}\n`);
      failures++;
    } else if (!probe.supported) {
      stderr(
        `Warning: running herdr (${probe.version ?? 'unknown'}) does not advertise capabilities.pane_strip; install the herdr-hud fork with pane strip support.\n`
      );
      failures++;
    } else {
      stdout(`Info: herdr ${probe.version ?? 'unknown'} (pane_strip supported, pane ${paneId})\n`);
    }
  }

  const distIndex = path.join(hudDir, 'dist/index.js');
  if (!fs.existsSync(distIndex)) {
    stderr(`Warning: HUD build output not found: ${distIndex}\n`);
    failures++;
  } else {
    stdout(`Info: HUD build output present (${distIndex})\n`);
  }

  if (failures > 0) {
    stderr(`Warning: Self-check found ${failures} issue(s).\n`);
    return 1;
  }
  stdout('Info: Self-check passed.\n');
  return 0;
}

function runPrintJson(env: NodeJS.ProcessEnv, stdout: (s: string) => void, stderr: (s: string) => void): number {
  const paneId = env.HERDR_PANE_ID;
  if (!herdrId(paneId)) {
    stderr('codex-hud: no herdr pane context (HERDR_PANE_ID is unset)\n');
    return 1;
  }
  const file = snapshotPath(env);
  try {
    stdout(fs.readFileSync(file, 'utf8'));
    return 0;
  } catch {
    stderr(`codex-hud: no state recorded yet for pane ${paneId}\n`);
    return 1;
  }
}

export interface CodexLaunchOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  hudDir?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export async function runCodexLaunch(
  args: readonly string[],
  options: CodexLaunchOptions = {}
): Promise<number> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const hudDir = options.hudDir ?? installationRoot();
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));

  if (args[0] === '-h' || args[0] === '--help') {
    stdout(CODEX_HUD_HELP);
    return 0;
  }
  if (args[0] === '--self-check') {
    return await runSelfCheck(env, hudDir, stdout, stderr);
  }
  if (args[0] === '--json') {
    return runPrintJson(env, stdout, stderr);
  }

  const codexArgs = args[0] === '--' ? args.slice(1) : args;

  let statusline: boolean;
  try {
    statusline = resolveStatuslineEnabled(env);
  } catch (error) {
    stderr(`Error: ${(error as Error).message}\n`);
    return 1;
  }

  let codexPath: string;
  try {
    codexPath = resolveCodexCli(env, path.join(hudDir, 'bin/codex-hud'));
  } catch (error) {
    stderr(`Error: ${(error as Error).message}\n`);
    return 1;
  }

  const effectiveCodexHome = env.CODEX_HOME || path.join(env.HOME || homedir(), '.codex');
  const effectiveHudHome = getHudHome(env);
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    CODEX_HOME: effectiveCodexHome,
    HUD_HOME: effectiveHudHome,
  };

  let paneId: string | null = null;
  let initialWidth = Number.isFinite(process.stdout.columns) && process.stdout.columns > 0 ? process.stdout.columns : 80;

  if (statusline) {
    const endpoint = herdrEndpoint(env);
    if (env.HERDR_ENV !== '1' || !endpoint || !herdrId(env.HERDR_PANE_ID)) {
      stderr(
        'Error: codexH requires a herdr pane with pane_strip support (herdr-hud fork). ' +
          'Run inside herdr-hud, or set CODEX_HUD_STATUSLINE=0 to launch Codex without the bar.\n'
      );
      return 1;
    }
    const probe = await probeHerdrPaneStrip(env);
    if (!probe.reachable) {
      stderr(
        `Error: could not reach the herdr socket (${endpoint}). ` +
          'codexH requires the herdr-hud fork with pane_strip support (or set CODEX_HUD_STATUSLINE=0 to launch Codex without the bar).\n'
      );
      return 1;
    }
    if (!probe.supported) {
      stderr(
        `Error: running herdr (${probe.version ?? 'unknown'}) does not advertise the pane_strip capability required by codexH. ` +
          'Install or upgrade the herdr-hud fork with pane strip support (or set CODEX_HUD_STATUSLINE=0 to launch Codex without the bar).\n'
      );
      return 1;
    }

    paneId = env.HERDR_PANE_ID;
    // Reserve the bottom strip BEFORE spawning Codex so the PTY starts already reduced by 1 row.
    const reserved = await setPaneStrip(
      paneId,
      { position: 'bottom', line: initialStripLine(env), leaseMs: STRIP_LEASE_MS },
      { timeoutMs: 2000, env }
    );
    if (!reserved || reserved.error) {
      const reason = reserved?.error?.message || reserved?.error?.code || 'no response';
      stderr(`Error: failed to reserve herdr pane strip on ${paneId}: ${reason}\n`);
      return 1;
    }
    const stripWidth = Number(reserved.result?.strip?.width);
    if (Number.isInteger(stripWidth) && stripWidth > 0) {
      initialWidth = stripWidth;
    }
  }

  void reportMainPaneGroup(cwd, childEnv, effectiveHudHome);
  const command = buildCodexCommand(codexPath, codexArgs, childEnv);
  const sessionStartSec = Math.floor(Date.now() / 1000);
  const codexChild = spawn(command[0], command.slice(1), {
    cwd,
    env: childEnv,
    stdio: 'inherit',
    shell: false,
  });

  let codexExited = false;
  let barChild: ChildProcess | null = null;
  const hudDistScript = path.join(hudDir, 'bin/hud-dist.mjs');

  const spawnBar = () => {
    if (!paneId || codexExited) return;
    const barEnv: NodeJS.ProcessEnv = {
      ...childEnv,
      CODEX_HUD_CWD: cwd,
      CODEX_HUD_SESSION_START: String(sessionStartSec),
      CODEX_HUD_STRIP_PANE: paneId,
      CODEX_HUD_STRIP_WIDTH: String(initialWidth),
      CODEX_HUD_PARENT_PID: String(process.pid),
      ...(codexChild.pid ? { CODEX_HUD_CODEX_PID: String(codexChild.pid) } : {}),
    };
    const next = spawn(process.execPath, [hudDistScript, 'bar'], {
      cwd,
      env: barEnv,
      stdio: 'ignore',
      shell: false,
    });
    barChild = next;
    next.on('error', () => {
      if (barChild === next) barChild = null;
    });
    next.on('exit', (code) => {
      if (barChild === next) barChild = null;
      // Seamless hot-reload: bar exited 75 after detecting a fresh npm run build.
      if (!codexExited && code === BAR_RELOAD_EXIT_CODE) {
        spawnBar();
      }
    });
  };

  if (paneId) {
    spawnBar();
  }

  // Keep Ctrl-C inside the interactive Codex TUI without terminating this launcher early.
  const onSigint = () => {};
  const onTerm = (signal: NodeJS.Signals) => {
    try {
      codexChild.kill(signal);
    } catch {
      /* already exited */
    }
  };
  const onSigterm = () => onTerm('SIGTERM');
  const onSighup = () => onTerm('SIGHUP');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  process.on('SIGHUP', onSighup);

  const exitCode = await new Promise<number>((resolve) => {
    codexChild.once('error', (error) => {
      stderr(`Error: failed to launch codex: ${error.message}\n`);
      resolve(1);
    });
    codexChild.once('exit', (code, signal) => {
      resolve(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : signal === 'SIGHUP' ? 129 : 1));
    });
  });

  codexExited = true;
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
  process.off('SIGHUP', onSighup);

  const runningBar = barChild as ChildProcess | null;
  if (runningBar) {
    barChild = null;
    try {
      runningBar.kill('SIGTERM');
    } catch {
      /* already exited */
    }
    await waitForExit(runningBar, 1000);
  }
  if (paneId) {
    await clearPaneStrip(paneId, 'bottom', { timeoutMs: 1000, env }).catch(() => null);
  }

  return exitCode;
}
