import * as fs from 'node:fs';
import { join } from 'node:path';
import { ClaudeNativeTree } from '../../dist-test/src/collectors/claude-native-tree.js';
import { buildSubagentTree } from '../../dist-test/src/collectors/subagent-tree.js';
import { buildWorkboard } from '../../dist-test/src/collectors/workboard.js';
import { renderMonitor, initialMonitorState } from '../../dist-test/src/render/monitor.js';
import { setLanguage } from '../../dist-test/src/render/i18n.js';
import { setDisplayConfig } from '../../dist-test/src/render/hud-config.js';
import { stripAnsi } from '../../dist-test/src/render/colors.js';
export const NOW = Date.parse('2026-11-12T12:00:00Z');
export function nativeFixture(home) {
  const source = join(home, 'claude-project'),
    session = 'synthetic-claude';
  const dir = join(source, session, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const put = (file, value) => {
    fs.mkdirSync(join(file, '..'), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    fs.utimesSync(file, new Date(NOW), new Date(NOW));
  };
  const line = (value) => JSON.stringify(value) + '\n';
  const message = (content, at = NOW - 60_000) => ({
    type: 'assistant',
    timestamp: new Date(at).toISOString(),
    message: { role: 'assistant', model: 'claude-sonnet-4-5', content },
  });
  put(join(source, session + '.jsonl'), '');
  put(join(dir, 'agent-lead.meta.json'), {
    agentType: 'custom-builder',
    description: 'Repair parser',
    toolUseId: 'root-call',
    spawnDepth: 1,
    finished: false,
  });
  put(
    join(dir, 'agent-lead.jsonl'),
    line(
      message([
        { type: 'thinking', thinking: 'PRIVATE-CLAUDE' },
        { type: 'text', text: 'Checking parser boundaries.' },
        { type: 'tool_use', id: 'nested-call', name: 'Agent', input: { description: 'Check tests' } },
      ])
    )
  );
  put(join(dir, 'agent-child.meta.json'), {
    agentType: 'custom-tester',
    description: 'Check parser tests',
    toolUseId: 'nested-call',
    spawnDepth: 2,
    finished: true,
  });
  put(
    join(dir, 'agent-child.jsonl'),
    line(message([{ type: 'text', text: 'Parser tests pass.' }])) +
      line({
        ...message([{ type: 'text', text: 'PRIVATE-CHANNEL' }]),
        message: { role: 'assistant', channel: 'analysis', content: [{ type: 'text', text: 'PRIVATE-CHANNEL' }] },
      })
  );
  const collector = new ClaudeNativeTree();
  const claude = () => collector.refresh(source, session);
  const listed = [];
  for (const [id, parent, name] of [
    ['codex-lead', 'synthetic-codex', 'Review schema'],
    ['codex-child', 'codex-lead', 'Check migration'],
    ['codex-leaf', 'codex-child', 'Verify index'],
  ]) {
    const file = join(home, id + '.jsonl');
    put(
      file,
      line({
        type: 'session_meta',
        payload: {
          id,
          parent_thread_id: parent,
          agent_nickname: name,
          agent_role: 'reviewer',
          model: 'gpt-5',
          timestamp: new Date(NOW - 120000).toISOString(),
        },
      }) +
        line({ type: 'event_msg', timestamp: new Date(NOW - 60000).toISOString(), payload: { type: 'task_started' } }) +
        line({
          type: 'response_item',
          timestamp: new Date(NOW - 60000).toISOString(),
          payload: {
            type: 'message',
            role: 'assistant',
            channel: 'commentary',
            content: [{ type: 'output_text', text: 'Reviewing schema evidence.' }],
          },
        })
    );
    const st = fs.statSync(file);
    listed.push({ path: file, size: st.size, modifiedAt: st.mtime, ino: st.ino });
  }
  const codex = buildSubagentTree('synthetic-codex', [], 3, NOW, listed);
  const combined = () => ({ ...codex, nodes: [...claude().nodes, ...codex.nodes], totalCount: 5 });
  const board = (tree = combined()) =>
    buildWorkboard(
      home,
      { revision: 0, lanes: [], coverage: { incomplete: false, workspace: home, diagnostics: [] }, cost: {} },
      { generation: 0, root: null, jobs: [], coverage: { incomplete: false, diagnostics: [] } },
      tree
    );
  const render = (width = 80, language = 'en', state = initialMonitorState(), tree = combined()) => {
    const display = setDisplayConfig({ theme: 'none', icons: 'unicode' }),
      lang = setLanguage(language);
    try {
      return renderMonitor({ tree, workboard: board(tree), state, width, height: 28, nowMs: NOW, modelEnabled: false });
    } finally {
      setDisplayConfig(display);
      setLanguage(lang);
    }
  };
  return { home, dir, source, session, put, collector, claude, codex, combined, board, render };
}
export function nativeFrames(f) {
  return Object.fromEntries(
    [80, 120].flatMap((width) =>
      ['en', 'zh'].map((lang) => [`${lang}-${width}`, f.render(width, lang).lines.map(stripAnsi)])
    )
  );
}
