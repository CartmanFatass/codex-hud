// Copied into synthetic installed packages: resolve the shared host from the explicit test repo.
import { pathToFileURL } from 'node:url';
const { runPackageHost } = await import(pathToFileURL(process.env.HUD_TEST_REPO + '/tests/fakes/pi.mjs'));
await runPackageHost();
