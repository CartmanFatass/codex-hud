/** Pi-loadable entrypoint shared by source checkouts and relocated runtime bundles.
 * Build HUD first, then load this file with pi -e. No source-only runtime imports.
 */
export { default } from '../../dist/harness/pi/wake-extension.js';
export * from '../../dist/harness/pi/wake-extension.js';
