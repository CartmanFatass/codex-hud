// Test-only deterministic cut inside the actual supervisor process.
import { writeFileSync } from 'node:fs';
import { FileRunFactPort } from '../../dist/core/run/fake-port.js';
export function createRunFactPort(home) {
  return new (class extends FileRunFactPort {
    cut(point) {
      if (process.env.HUD_RUN_TEST_CUT === point) {
        writeFileSync(`${home}/cut.json`, JSON.stringify({ point, pid: process.pid }), { mode: 0o600 });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
    }
    async phase(id, stamp, phase) {
      await super.phase(id, stamp, phase);
      if (phase === 'submitted') this.cut('submitted_before_scope');
    }
    async raw(id, stamp, kind, payload) {
      if (kind === 'cancel.step') this.cut('cancel_before_ack_commit');
      return super.raw(id, stamp, kind, payload);
    }
  })(`${home}/facts.json`);
}
