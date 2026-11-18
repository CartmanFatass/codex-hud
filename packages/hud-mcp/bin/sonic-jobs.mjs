/** Read the same sonic settlement facts for wait and the CLI parent supervisor. */
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';

export function sonicState(dir) {
  let status;
  try { status = JSON.parse(fs.readFileSync(join(dir, 'STATUS.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (['failed', 'stopped'].includes(status?.state)) {
    return { state: 'failed', reason: status.exit_reason ?? status.error ?? status.reason ?? status.state };
  }
  return { state: ['idle_grace', 'closed', 'done'].includes(status?.state) ? 'settled' : 'open' };
}

export function sonicChildren(dir) {
  let ids;
  try { ids = fs.readdirSync(join(dir, '.sonic')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; ids = []; }
  const uncollected = [];
  let open = false;
  for (const id of ids) {
    const child = join(dirname(dir), id);
    if (!fs.existsSync(join(child, 'job.json'))) continue; // Retention can remove settled children.
    const { state } = sonicState(child);
    if (state === 'open') open = true;
    if (state === 'settled' && fs.existsSync(join(child, 'report.md')) &&
        !fs.existsSync(join(child, 'sonic-collected')) && !fs.existsSync(join(child, 'sonic-prompted'))) {
      uncollected.push(id);
    }
  }
  return { open, uncollected };
}
