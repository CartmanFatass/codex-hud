import { createJevHost } from './jev-host.js';
import { attachNativeWake } from './host-wake.js';
import { NativeSessionHost } from './host.js';
import { nativeProfiles } from './host-config.js';
import { serveNativeHost } from './host-ipc.js';
import { RelationStore, type NativeOwner } from './relations.js';
import { pathToFileURL } from 'node:url';
export async function main(args = process.argv.slice(2)): Promise<void> {
  const [home, rawOwner] = args;
  if (!home || !rawOwner) throw new Error('native_host_requires_home_and_owner');
  const owner = JSON.parse(rawOwner) as NativeOwner;
  if (!owner || !['codex', 'claude', 'pi'].includes(owner.harness) || !owner.sourceId || !owner.sessionId)
    throw new Error('native_host_invalid_owner');
  const host = new NativeSessionHost(owner, nativeProfiles(home), new RelationStore(home));
  host.registerExtension('jev_', createJevHost(home, owner));
  host.registerExtension('wake_', attachNativeWake(home, host));
  await serveNativeHost(home, host);
  // Active native/Jev handles keep the host reachable regardless of parent lifetime.
  // After explicit last close the listener may unref; actual IPC/child handles drain naturally.
  // Bootstrap-only hosts remain referenced to preserve wake-register -> create handoff.
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch((error) => {
    process.stderr.write(`hud-native-host: ${error.message}\n`);
    process.exitCode = 1;
  });
