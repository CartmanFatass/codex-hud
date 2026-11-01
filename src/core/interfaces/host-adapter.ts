import type { HostKind, HostLayout, LaunchCommand, LocatorCheck } from '../types/capabilities.js';
import type { Harness, RunBinding, SessionRef } from '../types/identity.js';
import type { SurfaceLocator } from './session-binding.js';

/** Concept §6.10; contract 05: retain occupant generation; a managed run is optional. */
export interface SurfaceOptions {
  cwd: string;
  env: Readonly<Record<string, string>>;
  managed: Pick<RunBinding, 'runId' | 'bindingGeneration'> | null;
}

export interface HostAdapter {
  readonly kind: Exclude<HostKind, 'none'>;
  /** Concept §6.10: create a visible surface, including explicit environment injection. */
  openSurface(layout: Exclude<HostLayout, 'none'>, options: SurfaceOptions): Promise<SurfaceLocator>;
  /** Concept §6.10; contract 05 I-05-2: submit hud-run once; argv is quoted only at the final text hop. */
  runInSurface(locator: SurfaceLocator, command: LaunchCommand): Promise<void>;
  /** Concept §6.10: resolve a session or fixed run, without making historical locators current. */
  locate(target: SessionRef | string): Promise<SurfaceLocator | null>;
  /** Contract 05 “宿主、定位与 timeout”: recheck server, generation, occupant and foreground; errors are unknown. */
  checkLocator(locator: SurfaceLocator): Promise<LocatorCheck>;
  /** Concept §6.10; contract 05 I-05-4: recheck locator and interaction.focus at execution; refuse stale/unknown. */
  focus(locator: SurfaceLocator): Promise<void>;
  /** Concept §6.10; contract 05 I-05-4: recheck occupant and interaction.input; never send to a replacement shell. */
  sendKeys(locator: SurfaceLocator, keys: readonly string[]): Promise<void>;
  /** Concept §6.10: mark the actual harness identity on this adapter's surface context. */
  attachIdentity(harness: Harness): Promise<void>;
}
