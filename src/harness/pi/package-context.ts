/** Narrow public pi API projections; no SDK runtime dependency. */
import type { PiContext } from './delegation-context.js';
import type { SegmentContext } from './segment.js';
import type { FooterContext } from './footer-host.js';
export interface PiPackageBinding {
  release: string;
  node: string;
  hudHome: string;
}
export interface PiPackageContext extends PiContext, SegmentContext {
  cwd: string;
  model?: FooterContext['model'];
  getContextUsage: FooterContext['getContextUsage'];
  sessionManager: PiContext['sessionManager'] &
    FooterContext['sessionManager'] & {
      getHeader(): { type: string; id: string; cwd: string; parentSession?: string } | null;
    };
  ui: SegmentContext['ui'] & FooterContext['ui'];
}
