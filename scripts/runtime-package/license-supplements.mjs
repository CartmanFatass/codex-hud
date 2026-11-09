/** Published standardwebhooks 1.1.1 omits its parent libraries/LICENSE.
 * npm metadata gitHead b4d2c14fc5b4ccff3ff271e3b087dff812254c59 was checked:
 * libraries/javascript/package.json at that commit declares version 1.1.1.
 * This is the libraries' MIT license, not the repository root's Apache license.
 * Source: https://github.com/standard-webhooks/standard-webhooks/blob/b4d2c14fc5b4ccff3ff271e3b087dff812254c59/libraries/LICENSE
 * Captured 2026-11-09. Any package/version/integrity change needs fresh review.
 */
export const LICENSE_SUPPLEMENT = Object.freeze({
  name: 'standardwebhooks',
  version: '1.1.1',
  integrity: 'sha512-bCbX9ZEyFkWPsRz7Bl3NuQUJohmwGSev/yhr7vhaGPlc4AfIrspIRa6cPTBuI1ItmrTDJ4d/S2hCsfe4+vQGnQ==',
  source: 'scripts/runtime-package/license-supplements/standardwebhooks-1.1.1-LICENSE.txt',
  sha256: '5ec8c7b26b64d881a6706617bed25c049f97f2f35de034c756de8546fd6dbe27',
  repository: 'https://github.com/standard-webhooks/standard-webhooks',
  commit: 'b4d2c14fc5b4ccff3ff271e3b087dff812254c59',
});
export function licenseSupplement(name, locked) {
  return name === LICENSE_SUPPLEMENT.name &&
    locked.version === LICENSE_SUPPLEMENT.version &&
    locked.integrity === LICENSE_SUPPLEMENT.integrity
    ? LICENSE_SUPPLEMENT
    : null;
}
