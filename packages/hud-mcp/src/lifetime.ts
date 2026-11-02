import { readProcess } from '../../../src/core/run/process.js';
import { sameProcessStamp } from '../../../src/core/supervision.js';

/** The immediate spawning process owns stdio, even when a shell sits below the harness. */
export class ParentLifetime {
  private readonly pid = process.ppid;
  private readonly stamp = readProcess(this.pid)?.stamp ?? null;
  alive(): boolean {
    if (process.ppid !== this.pid || !this.stamp) return false;
    const current = readProcess(this.pid);
    return !!current && !['Z', 'X'].includes(current.state) && sameProcessStamp(this.stamp, current.stamp);
  }
}
