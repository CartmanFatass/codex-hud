import { sessionRefKey } from '../../src/core/identity.js';
import type {
  BindContext,
  HarnessAdapter,
  ReaderBudget,
  ReaderResult,
  SessionReader,
} from '../../src/core/interfaces/harness-adapter.js';
import type { LaunchProfile } from '../../src/core/types/capabilities.js';
import type { Harness, SessionRef, SourceId } from '../../src/core/types/identity.js';
import type { SessionBinding } from '../../src/core/interfaces/session-binding.js';
import type { ReaderCheckpoint } from '../../src/core/types/observation.js';
import { Script } from './script.js';

export class FakeSessionReader implements SessionReader {
  readonly readScript = new Script<[ReaderBudget?], ReaderResult>();

  async read(budget?: ReaderBudget): Promise<ReaderResult> {
    return this.readScript.invoke(budget);
  }
}

export class FakeHarnessAdapter implements HarnessAdapter {
  readonly glyph = 'H';
  readonly resolveSourceScript = new Script<[LaunchProfile, Readonly<Record<string, string | undefined>>], SourceId>();
  readonly bindScript = new Script<[BindContext], SessionBinding | null>();
  readonly childrenScript = new Script<[SessionRef], SessionRef[]>();
  readonly capabilities: HarnessAdapter['capabilities'] = {};
  readonly openCalls: [SessionRef, ReaderCheckpoint?][] = [];
  readonly readers = new Map<string, SessionReader>();

  constructor(readonly id: Harness) {}

  async resolveSource(profile: LaunchProfile, env: Readonly<Record<string, string | undefined>>): Promise<SourceId> {
    return this.resolveSourceScript.invoke(profile, env);
  }
  async bind(context: BindContext): Promise<SessionBinding | null> {
    return this.bindScript.invoke(context);
  }
  open(ref: SessionRef, checkpoint?: ReaderCheckpoint): SessionReader {
    this.openCalls.push(structuredClone([ref, checkpoint]));
    const reader = this.readers.get(sessionRefKey(ref));
    if (!reader) throw new Error('fake_reader_missing');
    return reader;
  }
  async children(ref: SessionRef): Promise<SessionRef[]> {
    return this.childrenScript.invoke(ref);
  }
}
