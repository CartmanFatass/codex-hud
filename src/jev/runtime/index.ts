// Jev executor for R2. One process per HUD home, started on demand.
//
// connectJevExecutor / createJevExecutor(hudHome):
//   createJob({ requestKey, session: { namespace, sessionId }, jevDecisions?, input })
//   readJob(jobId, { waitMs?, afterSeq?, signal? })
//   sendFollowUp(jobId, { key, text })
//   closeJob(jobId)
//
// input.tag is ask | browse | judge. jevDecisions is the resolved profile; this
// module does not read routing.toml. Disconnecting a read ends that observation
// only. Pass afterSeq: job.seq to wait for a newer seq. A newer seq is not
// terminal; poll until state is. The first read, with the default afterSeq of
// -1, returns the job as it is. After an idle exit the same handle starts the
// runtime again and retries the call once.

export { connectJevExecutor, type ConnectedJev, type ConnectOptions } from './client.js';
export {
  DEFAULT_GRACE_MS,
  JevRuntime,
  JevRuntimeError,
  askRecordKey,
  type AskTarget,
  type ResolvedDecision,
  type RuntimeOptions,
} from './executor.js';
export type {
  JevAskTarget,
  JevCreateRequest,
  JevDecisionId,
  JevDecisionProfile,
  JevExecutor,
  JevFollowUp,
  JevJob,
  JevJobInput,
  JevJobState,
  JevJobTag,
  JevReadOptions,
  JevSession,
} from './types.js';

import { connectJevExecutor } from './client.js';

/** Same entry as connectJevExecutor. Calling it starts the runtime when it is down. */
export const createJevExecutor = connectJevExecutor;
