import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HarnessAdapter } from '../../core/interfaces/harness-adapter.js';
import type { SessionBinding } from '../../core/interfaces/session-binding.js';
import type { LaunchProfile } from '../../core/types/capabilities.js';
import type { SessionRef, SourceId } from '../../core/types/identity.js';
import type { ReaderCheckpoint } from '../../core/types/observation.js';
import { makeSourceId } from '../../core/identity.js';
import { bindClaude, ClaudeTranscriptFiles, type ClaudeBindContext } from './binding.js';
import { createClaudeReader, type ClaudeSessionReader, type ClaudeStatusline } from './reader.js';

export type { ClaudeBindContext } from './binding.js';
export { CLAUDE_READER_VERSION, DEFAULT_READER_BUDGET } from './reader.js';
export type {
  ClaudeCheckpoint,
  ClaudeReaderBudget,
  ClaudeReaderResult,
  ClaudeSessionEvidence,
  ClaudeSessionReader,
  ClaudeStatusline,
} from './reader.js';

interface ClaudeSource {
  files: ClaudeTranscriptFiles;
  serverNames: string[];
  statuslines: Map<string, ClaudeStatusline>;
}

/** Explicit-source Claude observations; native navigation and managed launch remain separate capabilities. */
export class ClaudeAdapter implements HarnessAdapter {
  readonly id = 'claude' as const;
  readonly glyph = '✳';
  readonly capabilities = {};
  private sources = new Map<SourceId, ClaudeSource>();

  async resolveSource(profile: LaunchProfile, env: Readonly<Record<string, string | undefined>>): Promise<SourceId> {
    if (profile.harness !== 'claude' || !path.isAbsolute(profile.source.root)) throw new Error('invalid_claude_source');
    const root = await fs.promises.realpath(profile.source.root);
    if (!(await fs.promises.stat(root)).isDirectory()) throw new Error('invalid_claude_source');
    const configured = profile.env.CLAUDE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR;
    if (configured !== undefined && (!path.isAbsolute(configured) || (await fs.promises.realpath(configured)) !== root))
      throw new Error('claude_source_mismatch');
    const sourceId = makeSourceId('claude', root);
    const existing = this.sources.get(sourceId);
    if (existing) {
      if (!existing.serverNames.includes(profile.mcpServerName)) existing.serverNames.push(profile.mcpServerName);
    } else
      this.sources.set(sourceId, {
        files: new ClaudeTranscriptFiles(root, sourceId),
        serverNames: [profile.mcpServerName],
        statuslines: new Map(),
      });
    return sourceId;
  }

  private source(ref: SessionRef): ClaudeSource {
    const source = this.sources.get(ref.sourceId);
    if (!source) throw new Error('unknown_claude_source');
    source.files.validate(ref);
    return source;
  }

  async bind(context: ClaudeBindContext): Promise<SessionBinding | null> {
    const source = this.sources.get(context.sourceId);
    if (!source) return null;
    const result = bindClaude(context, source.files);
    if (result && context.statusline)
      source.statuslines.set(
        JSON.stringify([result.sessionRef.sessionId, result.sessionRef.threadId]),
        structuredClone(context.statusline)
      );
    return result;
  }

  open(target: SessionRef, checkpoint?: ReaderCheckpoint): ClaudeSessionReader {
    const source = this.source(target);
    const ref = source.files.validate(structuredClone(target));
    return createClaudeReader(
      {
        ref,
        resolveFile: (deadlineMs) => source.files.resolve(ref, deadlineMs),
        serverNames: source.serverNames,
        statusline: source.statuslines.get(JSON.stringify([ref.sessionId, ref.threadId])),
      },
      checkpoint
    );
  }

  async children(ref: SessionRef): Promise<SessionRef[]> {
    this.source(ref);
    return [];
  }

  async collectTopology(ref: SessionRef, _budget: import('../../core/interfaces/harness-adapter.js').ReaderBudget) {
    this.source(ref);
    return {
      children: [],
      loaded: false,
      bytesRead: 0,
      recordsRead: 0,
      coverage: {
        state: 'partial' as const,
        skipped: {},
        gaps: ['native_topology_unavailable'],
        loaded: false,
        reason: 'native_topology_unavailable',
      },
    };
  }
}
