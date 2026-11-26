import { withDistLock } from '../../../scripts/dist-lock.mjs';

if (process.send) {
  const custodian = await withDistLock(() => import('../../../dist/mcp/land-custodian.js')).catch(() => null);
  if (custodian) custodian.runLandCustodian(process.argv[2]);
  else if (process.connected) process.send({ error: 'Could not load the land custodian; HUD may have been rebuilt. Retry the land.' }, () => {
    if (process.connected) process.disconnect();
  });
}
