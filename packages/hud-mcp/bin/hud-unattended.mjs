import { withDistLock } from '../../../scripts/dist-lock.mjs';

const { runUnattended } = await withDistLock(() => import('../../../dist/unattended/service.js'));
await runUnattended();
