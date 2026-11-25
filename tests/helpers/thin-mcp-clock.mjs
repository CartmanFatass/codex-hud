// NODE_OPTIONS is inherited. Only HUD deadline/fault tests need the preload hooks.
const [, script = ''] = process.argv;
if (/\/(hud-cli|hud-watch|hud-progress)\.mjs$/.test(script)) {
  const fs = (await import('node:fs')).default;
  const { join } = await import('node:path');
  const { syncBuiltinESMExports } = await import('node:module');
  const isCli = script.endsWith('/hud-cli.mjs');
  const isWatcher = script.endsWith('/hud-watch.mjs');

  // Accelerate deadlines, not observations: production still wakes from real socket/file events.
  if (isCli) {
    const now = Date.now,
      timer = globalThis.setTimeout,
      anchor = Date.now(),
      scale = Number(process.env.HUD_TEST_CLOCK_SCALE ?? 20);
    Date.now = () => anchor + (now() - anchor) * scale;
    globalThis.setTimeout = (fn, ms, ...args) => timer(fn, ms === 250 ? 15 : ms / scale, ...args);
    // Keep external done.json timestamps on the supervisor's accelerated clock so slow runs never expire declared turns early.
    const parse = JSON.parse;
    JSON.parse = (...args) => {
      const value = parse(...args);
      if (
        value &&
        typeof value === 'object' &&
        typeof value.seq === 'number' &&
        typeof value.sent_at === 'string' &&
        typeof value.report_sig === 'string' &&
        typeof value.at === 'string'
      ) {
        const realAt = Date.parse(value.at);
        if (Number.isFinite(realAt) && realAt >= anchor) {
          value.at = new Date(anchor + (realAt - anchor) * scale).toISOString();
        }
      }
      return value;
    };
    // These supervisor fixtures use stand-in foreground PIDs created outside a
    // pane. Model the environment herdr actually injects into that one occupant.
    const readFile = fs.readFileSync, dir = process.argv[2];
    fs.readFileSync = (file, ...args) => {
      const pid = /^\/proc\/(\d+)\/environ$/.exec(String(file))?.[1];
      if (pid && (pid === String(process.pid) || ['cli-pid', 'fake-agent-pid'].some(name => {
        const path = join(process.env.HOME, name); return fs.existsSync(path) && readFile(path, 'utf8') === pid;
      }))) {
        const fields = Object.fromEntries(readFile(join(dir, 'SESSION.txt'), 'utf8').trim().split('\n').map(l => l.split('=')));
        return `HUD_JOB_DIR=${dir}\0HERDR_PANE_ID=${fields.LEFT}\0HERDR_TAB_ID=${fields.TAB}\0` + (fields.LAUNCH ? `HUD_TAB_LAUNCH=${fields.LAUNCH}\0` : '');
      }
      return readFile(file, ...args);
    };
    const opendir = fs.opendirSync;
    fs.opendirSync = (...args) => {
      if (/^\/proc\/\d+\/task$/.test(args[0])) fs.appendFileSync(join(process.env.HOME, 'proc-scans'), 'scan\n');
      return opendir(...args);
    };
    const rename = fs.renameSync;
    fs.renameSync = (...args) => {
      if (args[1].endsWith('/STATUS.json')) fs.appendFileSync(join(process.env.HOME, 'status-writes'), args[1] + '\n');
      return rename(...args);
    };
  }
  if (script.endsWith('/hud-progress.mjs')) {
    const fault = join(process.env.HOME, 'progress-snapshot-enospc');
    const rename = fs.renameSync,
      open = fs.openSync;
    const enospc = () => Object.assign(new Error('synthetic ENOSPC in hud-progress'), { code: 'ENOSPC' });
    fs.renameSync = (from, to) => {
      if (to.endsWith('/worker-tree.json') && fs.existsSync(fault)) throw enospc();
      return rename(from, to);
    };
    fs.openSync = (file, ...args) => {
      if (
        typeof file === 'string' &&
        file.includes('/worker-tree.json.') &&
        fs.existsSync(fault) &&
        fs.readFileSync(fault, 'utf8') === 'open'
      )
        throw enospc();
      return open(file, ...args);
    };
  }
  if (isWatcher && process.env.HUD_TEST_WATCHER_CLOCK === '1') {
    const clock = join(process.env.HOME, 'watcher-clock'), now = Date.now;
    Date.now = () => {
      try { return Number(fs.readFileSync(clock, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return now(); throw error; }
    };
  }
  if (isWatcher || isCli) {
    const flag = join(process.env.HOME, 'snapshot-enospc'),
      rename = fs.renameSync,
      kill = process.kill;
    fs.renameSync = (from, to) => {
      if (to.endsWith('/worker-tree.json') && fs.existsSync(flag))
        throw Object.assign(new Error('synthetic ENOSPC'), { code: 'ENOSPC' });
      return rename(from, to);
    };
    if (isWatcher)
      process.kill = (pid, signal) => {
        if (signal && fs.existsSync(flag) && String(pid) === fs.readFileSync(flag, 'utf8')) return false;
        return kill(pid, signal);
      };
  }
  syncBuiltinESMExports();
}
