import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { HeadlessRunControl, type StartOptions } from './control.js';
import type { RunPortModule } from './port.js';

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 5))
    throw new Error('hud-run requires Node >= 22.5 for its ledger integration');
  if (args[0] === '--help') {
    process.stdout.write(
      'hud-run <start|status|logs|cancel|reconcile> [runId] [--grace ms] [--stderr] [--offset bytes]\nSet private HUD_HOME and HUD_RUN_PORT_MODULE (B2 adapter exporting createRunFactPort). start reads protected JSON from stdin.\n'
    );
    return;
  }
  const home = process.env.HUD_HOME,
    module = process.env.HUD_RUN_PORT_MODULE;
  if (!home || !isAbsolute(home) || !module || !isAbsolute(module))
    throw new Error('HUD_HOME and HUD_RUN_PORT_MODULE must be absolute; ledger adapter not configured');
  const st = lstatSync(home);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid!() || st.mode & 0o077)
    throw new Error('HUD_HOME must be a private directory owned by this uid');
  // The trusted integration adapter authenticates the manager and ledger paths.
  const adapter = (await import(pathToFileURL(module).href)) as RunPortModule;
  if (typeof adapter.createRunFactPort !== 'function') throw new Error('invalid RunFactPort adapter');
  const control = new HeadlessRunControl(await adapter.createRunFactPort(home), home, {
    kind: 'trusted_local',
    uid: process.getuid!(),
    invocationId: randomUUID(),
  });
  const [command, id, ...flags] = args;
  const numeric = (flag: string, fallback: number) => {
    const pos = flags.indexOf(flag);
    if (pos < 0) return fallback;
    const value = Number(flags[pos + 1]);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${flag}`);
    return value;
  };
  if (command === 'start') {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      const value = Buffer.from(chunk);
      bytes += value.length;
      if (bytes > 1_048_576) throw new Error('protected launch input too large');
      chunks.push(value);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as StartOptions & { briefBase64?: string };
    if (input.briefBase64 !== undefined) input.brief = Buffer.from(input.briefBase64, 'base64');
    await control.start(input);
    return;
  }
  if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('valid runId required');
  if (command === 'status') process.stdout.write(`${JSON.stringify(await control.status(id))}\n`);
  else if (command === 'cancel')
    process.stdout.write(`${JSON.stringify(await control.cancel(id, numeric('--grace', 10_000)))}\n`);
  else if (command === 'reconcile') process.stdout.write(`${JSON.stringify(await control.reconcile(id))}\n`);
  else if (command === 'logs')
    process.stdout.write(
      control.logs(id, flags.includes('--stderr') ? 'stderr' : 'stdout', numeric('--offset', 0)).data
    );
  else throw new Error('unknown hud-run command');
}
