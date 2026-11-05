import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { HarnessAdapter, ReaderBudget } from '../../core/interfaces/harness-adapter.js';
import type { LaunchProfile } from '../../core/types/capabilities.js';
import type { SessionRef, SourceId } from '../../core/types/identity.js';
import type { ReaderCheckpoint } from '../../core/types/observation.js';
import { makeSourceId } from '../../core/identity.js';
import { bindPi, PiTranscriptFiles, type PiBindContext } from './binding.js';
import { createPiReader } from './reader.js';
export { PI_READER_VERSION, DEFAULT_READER_BUDGET, createPiReader } from './reader.js';
export type { PiBindContext, PiCommandline } from './binding.js';
export type { PiReaderBudget, PiReaderResult, PiSessionEvidence, PiSessionReader } from './reader.js';
/** Observation-only C1 adapter. Registering a source never enables launch/resume/MCP capabilities. */
export class PiAdapter implements HarnessAdapter {
  readonly id = 'pi' as const;
  readonly glyph = 'π';
  readonly capabilities = {};
  private sources = new Map<SourceId, PiTranscriptFiles>();
  async resolveSource(profile: LaunchProfile, _env: Readonly<Record<string, string | undefined>>): Promise<SourceId> {
    if (profile.harness !== 'pi' || !path.isAbsolute(profile.source.root)) throw new Error('invalid_pi_source');
    const root = await fs.realpath(profile.source.root);
    if (!(await fs.stat(root)).isDirectory()) throw new Error('invalid_pi_source');
    const id = makeSourceId('pi', root);
    if (!this.sources.has(id)) this.sources.set(id, new PiTranscriptFiles(root, id));
    return id;
  }
  private source(ref: SessionRef): PiTranscriptFiles {
    const source = this.sources.get(ref.sourceId);
    if (!source) throw new Error('unknown_pi_source');
    source.validate(ref);
    return source;
  }
  async bind(context: PiBindContext) {
    const source = this.sources.get(context.sourceId);
    return source ? bindPi(context, source) : null;
  }
  open(ref: SessionRef, checkpoint?: ReaderCheckpoint) {
    const source = this.source(ref);
    return createPiReader({ ref, resolveFile: (deadline) => source.resolve(ref, deadline) }, checkpoint);
  }
  async children(ref: SessionRef): Promise<SessionRef[]> {
    this.source(ref);
    return [];
  }
  async collectTopology(ref: SessionRef, _budget: ReaderBudget) {
    this.source(ref);
    return {
      children: [],
      loaded: true,
      bytesRead: 0,
      recordsRead: 0,
      coverage: {
        state: 'complete' as const,
        skipped: {},
        gaps: [],
        loaded: true,
        reason: 'pi_has_no_native_subagents',
      },
    };
  }
}
