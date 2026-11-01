import { ownedProcesses, stopOwned } from './common.mjs';

await stopOwned(ownedProcesses());
