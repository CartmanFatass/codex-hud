import { pathToFileURL } from 'node:url';
import { withDistLock } from '../../../scripts/dist-lock.mjs';
const api = await withDistLock(() => import('../../../dist/runtime/notify.js'));
export const { hasAgyEvents, registerPiWatcher, watching, taskDelivery, paneInfo, notifyAgy, notify, ensureQueueWatcher } = api;
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await api.runNotifyCli();
