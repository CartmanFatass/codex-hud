import { readJsonBounded, writePrivateFile } from '../utils/atomic-fs.js';
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
  let raw: unknown;
  try { raw = readJsonBounded(file, LIMIT); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { data: {}, disabled: new Set<string>() };
    throw error;
  }
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
  writePrivateFile(file, text);
}
