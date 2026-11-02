import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { CliHerdrTransport } from '../../dist/integrations/herdr/transport.js';
import { readProcess } from '../../dist/core/run/process.js';

export async function until(probe, ms = 4000) {
  const end = performance.now() + ms;
  do {
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      /* bounded startup wait */
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (performance.now() < end);
  throw new Error('private_test_timeout');
}
export async function privateServer() {
  const root = await mkdtemp(join(tmpdir(), 'hud-b7-private-'));
  const env = {
    PATH: process.env.PATH,
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
    SHELL: '/bin/sh',
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_RUNTIME_DIR: join(root, 'runtime'),
    HUD_HOME: join(root, 'hud'),
    HERDR_CONFIG_PATH: join(root, 'config/herdr/config.toml'),
  };
  await mkdir(join(root, 'config/herdr'), { recursive: true });
  await mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 });
  await writeFile(env.HERDR_CONFIG_PATH, '');
  const child = spawn('herdr', ['--session', 'b7-private', 'server'], { env, detached: true, stdio: 'ignore' });
  const done = new Promise((resolve) => {
    child.once('error', () => resolve());
    child.once('exit', () => resolve());
  });
  const socket = join(root, 'config/herdr/sessions/b7-private/herdr.sock');
  const cleanup = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    let timer;
    await Promise.race([
      done,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 2000);
      }),
    ]);
    clearTimeout(timer);
    await done;
    await rm(root, { recursive: true, force: true });
  };
  try {
    await until(async () => {
      await access(socket);
      return true;
    });
    const stamp = readProcess(child.pid)?.stamp;
    if (!stamp) throw new Error('private_server_not_owned');
    const transport = new CliHerdrTransport(socket, { ...env, HERDR_ENV: '1' }, 'herdr', 1500, stamp);
    if (!(await transport.instance())) throw new Error('private_endpoint_not_verified');
    return { root, env, child, done, stamp, transport, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
