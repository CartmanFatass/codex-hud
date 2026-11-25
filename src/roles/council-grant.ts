import { runGrantStore } from './run-grant.js';
export type { OwnerGrant as CouncilGrant } from './run-grant.js';

export const councilGrants = runGrantStore('council-grant');
export const allowCouncil = councilGrants.issue;
