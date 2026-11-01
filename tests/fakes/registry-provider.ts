import type { RegistryProvider, RegistryRecord } from '../../src/core/interfaces/registry-provider.js';
import type { SurfaceLocator } from '../../src/core/interfaces/session-binding.js';
import type { SessionRef } from '../../src/core/types/identity.js';
import { Script } from './script.js';

export class FakeRegistryProvider implements RegistryProvider {
  readonly listScript = new Script<[], readonly RegistryRecord[]>();
  readonly getScript = new Script<[SurfaceLocator], RegistryRecord | null>();
  readonly sessionOfScript = new Script<[SurfaceLocator], SessionRef | null>();

  async list(): Promise<readonly RegistryRecord[]> {
    return this.listScript.invoke();
  }
  async get(locator: SurfaceLocator): Promise<RegistryRecord | null> {
    return this.getScript.invoke(locator);
  }
  async sessionOf(locator: SurfaceLocator): Promise<SessionRef | null> {
    return this.sessionOfScript.invoke(locator);
  }
}
