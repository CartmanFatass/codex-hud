/** Release-relative trust: never accept an inventory serialized by a task. */
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readOwnedText, record, type ContractContext, type ReleaseInventory } from './contracts.js';

export async function loadWorkerRelease(moduleUrl = import.meta.url): Promise<ReleaseInventory> {
  const file = fileURLToPath(moduleUrl);
  const root = resolve(dirname(file), '../../..');
  if (file !== join(root, 'dist/roles/pi-owned/release.js')) throw new Error('release_unavailable');
  // This module and verifier travel together in A1's immutable artifact, not cwd.
  const verifier = await import(pathToFileURL(join(root, 'runtime-package/manifest.mjs')).href);
  const bundle = verifier.verifyBundle(root);
  try {
    const resources: Record<string, string> = {};
    for (const entry of bundle.manifest.entries) resources[entry.path] = entry.sha256;
    const id = createHash('sha256').update(bundle.raw).digest('hex');
    return { id, root, resources };
  } finally {
    bundle.directory.close();
  }
}
export function contextForContract(file: string, release: ReleaseInventory): ContractContext {
  let raw: unknown;
  try {
    raw = JSON.parse(readOwnedText(file, 64 * 1024));
  } catch {
    throw new Error('invalid_contract');
  }
  if (!record(raw) || typeof raw.task_dir !== 'string' || typeof raw.cwd !== 'string')
    throw new Error('invalid_contract');
  return { jobDirectory: raw.task_dir, cwd: raw.cwd, release };
}
