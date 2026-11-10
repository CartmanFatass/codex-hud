/** Narrow public pi API projections; no SDK runtime dependency. */
import type { PiContext } from './delegation-context.js';
import type { SegmentContext } from './segment.js';
export interface PiPackageBinding {
  version: 1;
  release: string;
  digest: string;
  releaseVersion: string;
  node: string;
  hudHome: string;
}
export interface PiPackageContext extends PiContext, SegmentContext {
  cwd: string;
  sessionManager: PiContext['sessionManager'] & {
    getHeader(): { type: string; id: string; cwd: string; parentSession?: string } | null;
  };
  ui: SegmentContext['ui'] & { notify(message: string, type?: 'info' | 'warning' | 'error'): void };
}
