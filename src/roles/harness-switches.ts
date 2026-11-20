import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';

const LIMIT = 1024 * 1024;
export const harnessSwitchFile = (home: string) => join(home, 'harnesses.json');
export const piProviderId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_.:-]+$/.test(id);
const validId = (id: unknown): id is string => typeof id === 'string' && (id === 'pi'
  || (id.startsWith('pi:') && piProviderId(id.slice(3))) || /^(cli|bro):[A-Za-z0-9_.-]+$/.test(id));

export class HarnessSwitchError extends Error {
  readonly code = 'invalid_harness_switches';
  constructor(readonly path: string) {
    super('Invalid or unreadable harnesses.json');
  }
}

function readFile(file: string) {
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!st) return { data: {}, disabled: new Set<string>() };
  if (!st.isFile() || st.size > LIMIT) throw new HarnessSwitchError(file);
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HarnessSwitchError(file);
  const data = raw as Record<string, unknown>;
  const disabled = data.disabled;
  if (disabled !== undefined && (!Array.isArray(disabled) || !disabled.every(validId))) throw new HarnessSwitchError(file);
  return { data, disabled: new Set(disabled as string[] | undefined) };
}

export function readHarnessSwitches(home: string): ReadonlySet<string> {
  const file = harnessSwitchFile(home);
  try { return readFile(file).disabled; }
  catch { throw new HarnessSwitchError(file); }
}

/** Intent comes from the owner row, not a blind toggle against a possibly changed disk value. */
export function setHarnessDisabled(home: string, id: string, off: boolean): void {
  if (!validId(id)) throw new Error('Invalid harness switch ID');
  const file = harnessSwitchFile(home);
  const { data, disabled } = (() => {
    try { return readFile(file); }
    catch { throw new HarnessSwitchError(file); }
  })();
  if (disabled.has(id) === off) return;
  if (off) disabled.add(id);
  else disabled.delete(id);
  const text = JSON.stringify({ ...data, disabled: [...disabled] }, null, 2) + '\n';
  if (Buffer.byteLength(text) > LIMIT) throw new Error('Harness switch file is too large');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, text, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* Renamed or not created. */ }
  }
}
