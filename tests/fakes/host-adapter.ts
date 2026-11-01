import type { HostAdapter, SurfaceOptions } from '../../src/core/interfaces/host-adapter.js';
import type { HostKind, HostLayout, LaunchCommand, LocatorCheck } from '../../src/core/types/capabilities.js';
import type { Harness, SessionRef } from '../../src/core/types/identity.js';
import type { SurfaceLocator } from '../../src/core/interfaces/session-binding.js';
import { Script } from './script.js';

export class FakeHostAdapter implements HostAdapter {
  readonly openSurfaceScript = new Script<[Exclude<HostLayout, 'none'>, SurfaceOptions], SurfaceLocator>();
  readonly runInSurfaceScript = new Script<[SurfaceLocator, LaunchCommand], void>();
  readonly locateScript = new Script<[SessionRef | string], SurfaceLocator | null>();
  readonly checkLocatorScript = new Script<[SurfaceLocator], LocatorCheck>();
  readonly focusScript = new Script<[SurfaceLocator], void>();
  readonly sendKeysScript = new Script<[SurfaceLocator, readonly string[]], void>();
  readonly attachIdentityScript = new Script<[Harness], void>();

  constructor(readonly kind: Exclude<HostKind, 'none'>) {}

  async openSurface(layout: Exclude<HostLayout, 'none'>, options: SurfaceOptions): Promise<SurfaceLocator> {
    return this.openSurfaceScript.invoke(layout, options);
  }
  async runInSurface(locator: SurfaceLocator, command: LaunchCommand): Promise<void> {
    return this.runInSurfaceScript.invoke(locator, command);
  }
  async locate(target: SessionRef | string): Promise<SurfaceLocator | null> {
    return this.locateScript.invoke(target);
  }
  async checkLocator(locator: SurfaceLocator): Promise<LocatorCheck> {
    return this.checkLocatorScript.invoke(locator);
  }
  async focus(locator: SurfaceLocator): Promise<void> {
    return this.focusScript.invoke(locator);
  }
  async sendKeys(locator: SurfaceLocator, keys: readonly string[]): Promise<void> {
    return this.sendKeysScript.invoke(locator, keys);
  }
  async attachIdentity(harness: Harness): Promise<void> {
    return this.attachIdentityScript.invoke(harness);
  }
}
