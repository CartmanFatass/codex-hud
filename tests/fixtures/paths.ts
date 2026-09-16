/**
 * Fixture locations. Compiled tests live under dist-test/tests/..., so the
 * repo root is three levels up from this module either way.
 */
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../../..');
export const ROLLOUT_FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures', 'rollouts');

export function rolloutFixture(name: string): string {
  return path.join(ROLLOUT_FIXTURES, name);
}
