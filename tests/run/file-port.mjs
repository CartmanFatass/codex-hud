// Test-only adapter selected explicitly; production B2 supplies the real ledger.
import { FileRunFactPort } from '../../dist/core/run/fake-port.js';
export function createRunFactPort(home) {
  return new FileRunFactPort(`${home}/facts.json`);
}
