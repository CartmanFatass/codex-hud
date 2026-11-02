/** Optional composition only: the core never imports this module. */
export { HerdrClient, HerdrFailure, HERDR_VERSION, HERDR_PROTOCOL, HERDR_SCHEMA } from './client.js';
export { CliHerdrTransport, type HerdrTransport } from './transport.js';
export { HerdrRegistry, type HerdrSessionResolver } from './registry.js';
export { HerdrHost, type SurfaceCloseProof } from './host.js';
export { HerdrRunControl, type InitialInputPermit } from './run-control.js';
