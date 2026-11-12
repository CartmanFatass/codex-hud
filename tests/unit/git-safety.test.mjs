import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { collectParityGit } from '../../dist/statusline-parity/git.js';
import { collectGitStatus } from '../../dist/collectors/git.js';
import { WorktreeCollector } from '../../dist/collectors/worktrees.js';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { createP10kFooter } from '../../dist/harness/pi/p10k-footer.js';
import { stripAnsi } from '../../dist/render/colors.js';

function fixture(t, mode) {
  const unsafe = mode === 'unsafe';
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-git-safety-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'repo');
  fs.mkdirSync(cwd);
  const git = (args) => execFileSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@invalid', ...args], { cwd, stdio: 'pipe' });
  git(['init', '-b', 'synthetic-safe']);
  const clean = unsafe ? 'unsafe=name' : 'repo-clean';
  fs.writeFileSync(join(cwd, '.gitattributes'), `clean.txt filter=${clean}\nprocess.txt filter=repo-process\n`);
  for (const name of ['clean.txt', 'process.txt']) fs.writeFileSync(join(cwd, name), 'old\n');
  git(['add', '.']);
  git(['commit', '-m', 'Synthetic baseline']);
  let target = cwd;
  if (mode === 'submodule') {
    const seed = join(root, 'seed');
    fs.mkdirSync(seed);
    git(['-C', seed, 'init', '-b', 'synthetic-submodule']);
    fs.writeFileSync(join(seed, '.gitattributes'), 'clean.txt filter=repo-clean\nprocess.txt filter=repo-process\n');
    for (const name of ['clean.txt', 'process.txt']) fs.writeFileSync(join(seed, name), 'old\n');
    git(['-C', seed, 'add', '.']);
    git(['-C', seed, 'commit', '-m', 'Synthetic submodule']);
    git(['-c', 'protocol.file.allow=always', 'submodule', 'add', seed, 'nested']);
    git(['commit', '-am', 'Synthetic gitlink']);
    target = join(cwd, 'nested');
  }
  const markers = {};
  for (const kind of ['clean', 'process', 'smudge', 'fsmonitor']) {
    markers[kind] = join(root, `${kind}.ran`);
    const script = join(root, `${kind}.sh`);
    fs.writeFileSync(script, `#!/bin/sh\nprintf yes > '${markers[kind]}'\n${kind === 'clean' || kind === 'smudge' ? 'cat' : 'exit 1'}\n`, { mode: 0o700 });
    git(['-C', target, 'config', kind === 'fsmonitor' ? 'core.fsmonitor' : `filter.${kind === 'process' ? 'repo-process' : clean}.${kind}`, script]);
  }
  // Same-size edits force hashing through filters, not Git's size-only dirty shortcut.
  for (const name of ['clean.txt', 'process.txt']) {
    fs.writeFileSync(join(target, name), 'new\n');
    fs.utimesSync(join(target, name), new Date(0), new Date(0));
  }
  return { cwd, markers };
}

async function piFacts(cwd) {
  let component, pending = 0, started = false;
  // Observe completion without replacing the real Git subprocess or its result.
  const execFile = childProcess.execFile;
  childProcess.execFile = (...args) => {
    const done = args.pop();
    started = true;
    pending++;
    return execFile(...args, (...result) => {
      try { done(...result); } finally { pending--; }
    });
  };
  syncBuiltinESMExports();
  const host = {
    CustomEditor: class { render() { return []; } renderTopBorder() { return ''; } },
    visibleWidth: (text) => stripAnsi(text).length,
    truncateToWidth: (text, width) => text.slice(0, width),
  };
  const footer = createP10kFooter({}, host, process.env); // No injected Git dependency.
  try {
    footer.start({
      mode: 'tui', hasUI: true,
      sessionManager: {
        getSessionId: () => 'synthetic', getLeafId: () => null,
        getEntries: () => [], getBranch: () => [], getCwd: () => cwd,
      },
      getContextUsage: () => undefined,
      ui: {
        theme: { fg: (_token, text) => text }, notify() {}, setEditorComponent() {},
        setFooter(factory) {
          component = factory?.({ requestRender() {} }, {}, { getExtensionStatuses: () => new Map() });
        },
      },
    });
    const deadline = Date.now() + 4000;
    // Callback promise continuations (including filter rejection) settle between polls.
    // Failed reads request no repaint, so wait for the actual Git work instead.
    while ((!started || pending > 0) && Date.now() < deadline) await delay(20);
    assert.ok(started && pending === 0, 'real footer Git read completed');
    return stripAnsi(component.render(1000).join('\n'));
  } finally {
    footer.stop();
    childProcess.execFile = execFile;
    syncBuiltinESMExports();
  }
}

const paths = {
  Claude: async (cwd) => {
    const value = collectParityGit(cwd, process.env);
    return { branch: value?.branch, dirty: value?.dirty };
  },
  Codex: async (cwd) => {
    const value = await collectGitStatus(cwd);
    return { branch: value.branch ?? undefined, dirty: value.isGitRepo ? value.isDirty : undefined };
  },
  pi: async (cwd) => {
    const text = await piFacts(cwd);
    return { branch: text.includes('synthetic-safe') ? 'synthetic-safe' : undefined, dirty: text.includes('synthetic-safe') ? text.includes('*2') : undefined };
  },
  Project: async (cwd) => {
    const value = await new ProjectCollector(cwd, process.env.HUD_HOME).collect(true, { workers: [], lanes: [], decisions: [] }, Date.now());
    return { branch: value.git?.branch, dirty: value.git ? value.git.unstaged === 2 : undefined };
  },
  Changes: async (cwd) => {
    const value = (await new WorktreeCollector().refresh([cwd])).entries[0]?.status;
    return { branch: value?.branch, dirty: value ? value.unstaged === 2 : undefined };
  },
};

test('production Git safety matrix: repository commands never execute; facts survive safe neutralisation', async (t) => {
  for (const mode of ['repository', 'unsafe', 'submodule']) for (const [name, read] of Object.entries(paths)) {
    await t.test(`${name}: ${mode}`, async (t) => {
      const f = fixture(t, mode);
      const facts = await read(f.cwd);
      const markers = Object.fromEntries(Object.entries(f.markers).map(([kind, path]) => [kind, fs.existsSync(path)]));
      t.diagnostic(JSON.stringify({ path: name, mode, markers, facts }));
      assert.deepEqual(markers, { clean: false, process: false, smudge: false, fsmonitor: false });
      assert.equal(facts.dirty, mode === 'unsafe' ? undefined : mode === 'repository');
      assert.equal(facts.branch, mode === 'unsafe' ? undefined : 'synthetic-safe');
    });
  }
});
