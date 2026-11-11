#!/usr/bin/env node
/** Probe is provider-free and isolated. Activation is declarative A1 preview/apply/restore. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest } from './runtime-package/safety.mjs';
import { verifyBundle } from './runtime-package/manifest.mjs';
import {
  observe,
  planActivation,
  applyActivation,
  planDeactivation,
  restoreActivation,
} from './runtime-package/activation.mjs';
import { codexSteps, CODEX_LIMITATION } from './runtime-package/codex.mjs';
export async function codexRpc(executable, args, requests, env, cwd, observeReady = () => {}) {
  const started = performance.now();
  const child = spawn(executable, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let pending = '',
    stderr = '',
    count = 0;
  const replies = new Map(),
    waiting = new Map();
  let rejectAll;
  const failed = new Promise((_, reject) => {
    rejectAll = reject;
  });
  failed.catch(() => {});
  const close = new Promise((resolve) => {
    child.once('error', rejectAll);
    child.once('close', resolve);
  });
  const timer = setTimeout(() => rejectAll(Error('codex_rpc_deadline')), 20000);
  child.stderr.on('data', (b) => {
    if (stderr.length < 65536) stderr += b;
  });
  child.stdout.on('data', (b) => {
    if ((count += b.length) > 2 * 1024 * 1024) {
      rejectAll(Error('codex_rpc_output_limit'));
      return;
    }
    pending += b;
    while (pending.includes('\n')) {
      const n = pending.indexOf('\n'),
        line = pending.slice(0, n);
      pending = pending.slice(n + 1);
      try {
        const reply = JSON.parse(line);
        if (reply.id != null) {
          replies.set(reply.id, reply);
          waiting.get(reply.id)?.(reply);
        }
      } catch {
        rejectAll(Error('codex_rpc_invalid_json'));
      }
    }
  });
  child.once('exit', (code) => rejectAll(Error('codex_rpc_early_exit: ' + code)));
  try {
    for (const request of requests) {
      const answer = request.id == null ? null : new Promise((resolve) => waiting.set(request.id, resolve));
      child.stdin.write(JSON.stringify(request) + '\n');
      if (answer) {
        const r = await Promise.race([answer, failed]);
        if (r.error) throw Error(JSON.stringify(r.error));
      }
    }
    const readyMs = performance.now() - started;
    await observeReady(child);
    return { replies: Object.fromEntries(replies), stderr, readyMs };
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 2000);
    await close;
    clearTimeout(kill);
  }
}
export async function probeCodex(executable, userHome, codexHome) {
  for (const p of [executable, userHome, codexHome])
    if (!path.isAbsolute(p ?? '') || path.resolve(p) !== p) throw Error('explicit_absolute_probe_targets_required');
  const root = fs.mkdtempSync(path.join(tmpdir(), 'hud-codex-probe-'));
  fs.chmodSync(root, 0o700);
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    HUD_HOME: path.join(root, 'hud'),
    CODEX_HOME: path.join(root, 'codex'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
  };
  for (const p of [env.HUD_HOME, env.CODEX_HOME, env.CLAUDE_CONFIG_DIR]) fs.mkdirSync(p, { mode: 0o700 });
  // These are hypotheses, not installation defaults: require the native user-scope result to select one.
  const candidates = ['.agents/skills'];
  for (const candidate of candidates) {
    const dir = path.join(root, candidate, 'hud-location-probe');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      '---\nname: hud-location-probe\ndescription: Synthetic HUD location discovery only.\n---\nNo actions.\n',
      { mode: 0o600 }
    );
  }
  try {
    const version = spawnSync(executable, ['--version'], { env, cwd: root, encoding: 'utf8', timeout: 10000 });
    if (version.status !== 0) throw Error('codex_version_probe_failed');
    const result = await codexRpc(
      executable,
      ['app-server', '--stdio'],
      [
        {
          id: 1,
          method: 'initialize',
          params: { clientInfo: { name: 'hud_release_probe', version: '1' }, capabilities: { experimentalApi: true } },
        },
        { method: 'initialized' },
        { id: 2, method: 'skills/list', params: { cwds: [root], forceReload: true } },
      ],
      env,
      root
    );
    const skills = result.replies[2]?.result?.data?.flatMap((d) => d.skills ?? []) ?? [];
    const matches = candidates.filter((c) =>
      skills.some(
        (s) =>
          s.name === 'hud-location-probe' &&
          s.scope === 'user' &&
          s.enabled &&
          s.path === path.join(root, c, 'hud-location-probe/SKILL.md')
      )
    );
    if (matches.length !== 1) throw Error('codex_user_skill_location_NOT_VERIFIED');
    return {
      schema: 1,
      status: 'PASS',
      executable,
      executableHash: digest(fs.readFileSync(executable)),
      version: version.stdout.trim(),
      codexHome,
      skillDirectory: path.join(userHome, matches[0]),
      scope: 'user',
      nativeDiscovery: true,
      command: [executable, 'app-server', '--stdio'],
      probeRoot: root,
      providerRequests: 0,
      limitation: CODEX_LIMITATION,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
export async function codexActivationCommand(args, env = process.env) {
  const [verb, ...rest] = args,
    o = {};
  if (!['probe', 'preview', 'apply', 'restore-preview', 'restore'].includes(verb) || rest.length % 2)
    throw Error('invalid_codex_activation_arguments');
  for (let i = 0; i < rest.length; i += 2) {
    if (
      ![
        '--prefix',
        '--release',
        '--hud-home',
        '--shim-dir',
        '--node',
        '--codex',
        '--codex-home',
        '--user-home',
        '--skill-directory',
        '--proof',
        '--plan',
        '--receipt',
      ].includes(rest[i]) ||
      Object.hasOwn(o, rest[i])
    )
      throw Error('invalid_codex_activation_option');
    o[rest[i]] = rest[i + 1];
  }
  if (verb === 'probe') return probeCodex(o['--codex'], o['--user-home'], o['--codex-home']);
  if (verb.startsWith('restore')) {
    if (!o['--receipt'] || (verb === 'restore' && !o['--plan'])) throw Error('explicit_restore_receipt_plan_required');
    return verb === 'restore-preview'
      ? planDeactivation(o['--receipt'])
      : restoreActivation(o['--receipt'], o['--plan']);
  }
  const options = {
    prefix: o['--prefix'],
    release: o['--release'],
    hudHome: o['--hud-home'] ?? env.HUD_HOME,
    shimDir: o['--shim-dir'],
    path: env.PATH ?? '',
    codex: {
      node: o['--node'],
      executable: o['--codex'],
      codexHome: o['--codex-home'],
      skillDirectory: o['--skill-directory'],
    },
  };
  const proofState = observe(o['--proof']);
  if (proofState.kind !== 'file') throw Error('codex_skill_probe_required');
  const proofBytes = fs.readFileSync(o['--proof']);
  if (digest(proofBytes) !== proofState.sha256) throw Error('codex_proof_changed');
  try {
    options.codex.proof = JSON.parse(proofBytes);
  } catch {
    throw new Error('codex_probe_invalid_json');
  }
  const bundle = verifyBundle(path.join(options.prefix, 'releases', options.release), { required: false });
  let generated;
  try {
    generated = codexSteps(bundle, options, observe);
  } finally {
    bundle.directory.close();
  }
  options.steps = generated.steps;
  if (verb === 'apply' && !o['--plan']) throw Error('explicit_plan_required');
  if (verb === 'preview' && o['--plan']) throw Error('preview_has_no_plan_argument');
  const result = verb === 'preview' ? planActivation(options) : applyActivation(options, o['--plan']);
  // The limitation is part of confirmation text (and thus the plan), not an unauthenticated status claim.
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--help')
    console.log(
      `node RELEASE/codex-activation.mjs probe --codex ABS --user-home ABS --codex-home ABS\npreview|apply --prefix ABS --release DIGEST --hud-home ABS --shim-dir ABS --node ABS --codex ABS --codex-home ABS --skill-directory VERIFIED_ABS --proof ABS [--plan ID]\nrestore-preview|restore --receipt ABS [--plan ID]\nOne explicitly selected config; no wildcard, launcher or bar changes. Probe runs only in a temporary home.\n${CODEX_LIMITATION}`
    );
  else
    codexActivationCommand(process.argv.slice(2))
      .then((r) => console.log(JSON.stringify(r, null, 2)))
      .catch((e) => {
        console.error(e.message);
        process.exitCode = 1;
      });
}
