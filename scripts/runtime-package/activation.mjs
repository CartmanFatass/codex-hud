/** Reversible activation, separate from immutable runtime installation. Node builtins only.
 * Client adapters supply declarative steps via options.steps; they do not mutate during preview.
 * Existing client files require an explicit expectedOriginalHash and confirmation text.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  Directory,
  digest,
  json,
  same,
  identity,
  exists,
  runtime,
  syncDirectory,
  listNames,
  MAX_FILE,
} from './safety.mjs';
import { COMMANDS, verifyBundle } from './manifest.mjs';
import { claudeSteps } from './claude.mjs';
import { inspectPrefix, selectorValue, selectorBytes } from './installer.mjs';
import { refuseActivationLock, recoverActivationLocks, withActivationLocks } from './activation-lock.mjs';

export const PUBLIC_NAMES = Object.freeze(['hud', 'hud-statusline', 'hud-mcp']);
const HASH = /^[a-f0-9]{64}$/;
const BEGIN = '# >>> universal-hud PATH >>>';
const END = '# <<< universal-hud PATH <<<';
function absolute(file) {
  if (
    typeof file !== 'string' ||
    !path.isAbsolute(file) ||
    path.resolve(file) !== file ||
    file === '/' ||
    /[\0\r\n]/.test(file)
  )
    throw new Error('canonical_absolute_target_required');
  return file;
}
/** Inspect every ancestor, never follow links, including absent descendants. */
export function observe(file) {
  absolute(file);
  const parents = [];
  let current = '';
  const parts = file.slice(1).split('/');
  for (let i = 0; i < parts.length; i++) {
    current += '/' + parts[i];
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') return { kind: 'absent', parents };
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`symlink_target_refused: ${current}`);
    if (i < parts.length - 1) {
      if (!stat.isDirectory() || (stat.mode & 0o022 && !(stat.mode & 0o1000))) throw new Error('unsafe_target_parent');
      parents.push({ path: current, identity: identity(stat) });
    } else {
      if (stat.uid !== process.getuid() || stat.mode & 0o7022) throw new Error(`foreign_or_unsafe_target: ${file}`);
      if (stat.isDirectory()) return { kind: 'directory', identity: identity(stat), parents };
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('special_or_linked_target_refused');
      return withTarget(file, (named) => {
        const fd = fs.openSync(named, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
          const before = fs.fstatSync(fd);
          if (!same(identity(before), identity(stat)) || before.size > MAX_FILE)
            throw new Error('target_changed_or_oversize');
          const bytes = fs.readFileSync(fd);
          const after = fs.fstatSync(fd);
          if (
            bytes.length > MAX_FILE ||
            before.size !== after.size ||
            before.ctimeMs !== after.ctimeMs ||
            !same(identity(fs.lstatSync(named)), identity(before))
          )
            throw new Error('target_changed');
          return { kind: 'file', identity: identity(stat), sha256: digest(bytes), parents };
        } finally {
          fs.closeSync(fd);
        }
      });
    }
  }
}
function withTarget(file, action) {
  const directory = new Directory(path.dirname(file));
  try {
    directory.assert();
    const result = action(`${directory.base}/${path.basename(file)}`, directory);
    directory.assert();
    return result;
  } finally {
    directory.close();
  }
}
function bytes(file) {
  const state = observe(file);
  if (state.kind !== 'file') throw new Error('regular_owned_file_required');
  return withTarget(file, (named) => {
    const fd = fs.openSync(named, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const data = fs.readFileSync(fd);
      if (data.length > MAX_FILE || digest(data) !== state.sha256 || !same(identity(fs.fstatSync(fd)), state.identity))
        throw new Error('target_changed');
      return data;
    } finally {
      fs.closeSync(fd);
    }
  });
}
function bare(state) {
  const { parents: _parents, ...rest } = state;
  return rest;
}
function assertState(file, expected, parents = false) {
  const actual = observe(file);
  if (!same(parents ? actual : bare(actual), parents ? expected : bare(expected)))
    throw new Error(`activation_conflict: ${file}`);
  for (const parent of expected.parents ?? []) {
    const stat = fs.lstatSync(parent.path);
    if (!stat.isDirectory() || !same(identity(stat), parent.identity)) throw new Error('activation_parent_changed');
  }
  return actual;
}
function atomic(file, data, mode, expected) {
  withTarget(file, (named, parent) => {
    const temporary = `${named}.hud-activation-${process.pid}`;
    const fd = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600
    );
    try {
      fs.writeFileSync(fd, data);
      fs.fchmodSync(fd, mode);
      fs.fsyncSync(fd);
      parent.assert();
      assertState(file, expected);
      fs.renameSync(temporary, named);
      syncDirectory(parent.base);
    } finally {
      fs.closeSync(fd);
      if (exists(temporary)) fs.unlinkSync(temporary);
    }
  });
}
function mkdir(file) {
  withTarget(file, (named, parent) => {
    fs.mkdirSync(named, { mode: 0o700 });
    syncDirectory(parent.base);
  });
}
function remove(file, directory = false) {
  withTarget(file, (named, parent) => {
    if (directory) fs.rmdirSync(named);
    else fs.unlinkSync(named);
    syncDirectory(parent.base);
  });
}
function uuid(hash) {
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export function publicShim(prefix, hudHome, command, target) {
  if (!PUBLIC_NAMES.includes(command)) throw new Error('non_public_command_refused');
  const entry = path.join(prefix, 'releases', target, COMMANDS[command]);
  return `#!/usr/bin/env node
// Universal HUD owned activation shim; immutable release pin.
const [major, minor] = process.versions.node.split('.').map(Number);
if (process.platform !== 'linux' || !((major === 22 && minor >= 13) || major === 24)) {
  process.stderr.write('requires_linux_node_22_13_or_24\\n'); process.exit(5);
}
const fs = process.getBuiltinModule('fs');
const prefix = ${JSON.stringify(prefix)};
const entry = ${JSON.stringify(entry)};
try {
  if (fs.realpathSync(prefix) !== prefix) throw Error('unsafe_runtime_prefix');
  let current = prefix;
  const suffix = entry.slice(prefix.length + 1).split('/');
  for (let i = -1; i < suffix.length; i++) {
    if (i >= 0) current += '/' + suffix[i];
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || stat.uid !== process.getuid() || (i < suffix.length - 1 ? !stat.isDirectory() || (stat.mode & 0o7777) !== 0o700 : !stat.isFile() || stat.nlink !== 1 || ![0o600, 0o700].includes(stat.mode & 0o7777))) throw Error('unsafe_runtime_pin');
  }
} catch (error) { process.stderr.write(error.message + '\\n'); process.exit(5); }
if (!process.env.HUD_HOME) process.env.HUD_HOME = ${JSON.stringify(hudHome)};
${command === 'hud-mcp' ? "process.env.HUD_MCP_SURFACE = 'roles';\n" : ''}process.argv[1] = entry;
process.getBuiltinModule('module').runMain(entry);
`;
}
function knownShim(state, prefix, home, command, releases) {
  return (
    state.kind === 'file' &&
    releases.some((release) => digest(publicShim(prefix, home, command, release)) === state.sha256) &&
    state.identity.mode === 0o700
  );
}
function addDirectories(steps, file) {
  if (observe(file).kind !== 'absent') return;
  addDirectories(steps, path.dirname(file));
  if (!steps.some((step) => step.path === file)) steps.push({ kind: 'private-dir', path: file });
}
function metadata(home) {
  return path.join(home, 'installation');
}
export const ACTIVATION_HISTORY_LIMIT = 4096;
/** Complete, bounded receipt history; never truncate or skip an unreadable receipt. */
export function activationHistory(home, limit = ACTIVATION_HISTORY_LIMIT) {
  const root = metadata(home);
  if (observe(root).kind === 'absent') return { count: 0, sha256: digest(json([])) };
  const records = [];
  const directory = new Directory(root, true);
  try {
    for (const name of listNames(directory.base, ACTIVATION_HISTORY_LIMIT + 32)) {
      if (!name.endsWith('.json')) continue;
      if (records.length >= limit) throw new Error('activation_history_capacity_exceeded');
      const file = path.join(root, name);
      let state;
      try {
        state = observe(file);
      } catch (error) {
        throw new Error(`unsafe_activation_history_receipt: ${file}; ${error.message}`);
      }
      if (state.kind !== 'file' || state.identity.mode !== 0o600)
        throw new Error(`unsafe_activation_history_receipt: ${file}`);
      const data = bytes(file);
      if (digest(data) !== state.sha256) throw new Error('activation_history_changed');
      records.push({ name, sha256: state.sha256, identity: state.identity });
    }
    directory.assert();
    return { count: records.length, sha256: digest(json(records)) };
  } catch (error) {
    if (error.message === 'directory_entry_limit') throw new Error('activation_history_capacity_exceeded');
    throw error;
  } finally {
    directory.close();
  }
}
function strictRuntime(prefix, release, ignoreLock = false) {
  const directory = new Directory(prefix, true);
  try {
    const state = inspectPrefix(directory, ignoreLock);
    if (!state.releases.includes(release)) throw new Error('release_not_installed');
    const backed = Object.keys(state.receipts).some((name) => {
      const receipt = JSON.parse(directory.read(`receipts/${name}`).data);
      return receipt.bundleDigest === release && ['stage', 'apply'].includes(receipt.operation);
    });
    if (!backed) throw new Error('release_not_receipt_backed');
    return state;
  } finally {
    directory.close();
  }
}
/** Read-only deterministic preview. The exact same explicit options regenerate it at apply. */
export function planActivation(options, ignoreLock = false) {
  runtime();
  const prefix = absolute(options.prefix);
  const hudHome = absolute(options.hudHome);
  const shimDir = absolute(options.shimDir);
  if (observe(path.dirname(hudHome)).kind !== 'directory') throw new Error('hud_home_parent_must_exist');
  const release = options.release;
  if (!HASH.test(release ?? '')) throw new Error('invalid_release_digest');
  if (
    [prefix, shimDir].some((p) => p === hudHome || p.startsWith(hudHome + '/') || hudHome.startsWith(p + '/')) ||
    shimDir === prefix ||
    shimDir.startsWith(prefix + '/')
  )
    throw new Error('overlapping_activation_roots');
  if (!ignoreLock) refuseActivationLock(prefix, hudHome);
  const runtimeState = strictRuntime(prefix, release, ignoreLock);
  const releaseBundle = verifyBundle(path.join(prefix, 'releases', release), { required: false });
  let releaseVersion;
  let integration = null;
  try {
    releaseVersion =
      releaseBundle.manifest.releaseVersion ?? JSON.parse(releaseBundle.directory.read('package.json').data).version;
    if (options.claude) integration = claudeSteps(releaseBundle, { ...options, prefix, hudHome });
  } finally {
    releaseBundle.directory.close();
  }
  const recoveryState = observe(metadata(hudHome));
  if (recoveryState.kind !== 'absent' && (recoveryState.kind !== 'directory' || recoveryState.identity.mode !== 0o700))
    throw new Error('unsafe_installation_metadata');
  if (!ignoreLock && exists(path.join(metadata(hudHome), 'activation-lock')))
    throw new Error('activation_locked_manual_inspection_required');
  const steps = [];
  addDirectories(steps, hudHome);
  const homeState = observe(hudHome);
  if (homeState.kind !== 'absent' && (homeState.kind !== 'directory' || homeState.identity.mode !== 0o700))
    throw new Error('hud_home_must_be_private');
  // These are never generated, parsed, chmodded or replaced by activation.
  const preserved = ['credentials.env', 'config.json', 'routing.toml'].map((name) => ({
    path: path.join(hudHome, name),
    state: observe(path.join(hudHome, name)),
  }));
  for (const name of ['display', 'panels']) {
    const dir = path.join(hudHome, name);
    const state = observe(dir);
    if (state.kind !== 'absent' && (state.kind !== 'directory' || state.identity.mode !== 0o700))
      throw new Error('hud_owned_directory_must_be_private');
    addDirectories(steps, dir);
  }
  addDirectories(steps, shimDir);
  for (const command of PUBLIC_NAMES) {
    const file = path.join(shimDir, command);
    const original = observe(file);
    if (original.kind !== 'absent' && !knownShim(original, prefix, hudHome, command, runtimeState.releases))
      throw new Error(`foreign_public_shim: ${command}`);
    steps.push({
      kind: 'public-shim',
      path: file,
      content: publicShim(prefix, hudHome, command, release),
      mode: 0o700,
      original,
    });
  }
  const onPath = (options.path ?? '').split(path.delimiter).includes(shimDir);
  if (options.rcFile && !onPath) {
    const file = absolute(options.rcFile);
    const original = observe(file);
    if (!['absent', 'file'].includes(original.kind)) throw new Error('unsafe_rc_target');
    const prior = original.kind === 'file' ? bytes(file).toString('utf8') : '';
    if (prior.includes(BEGIN) || prior.includes(END)) throw new Error('existing_hud_path_block_requires_restore');
    const quote = "'" + shimDir.replace(/'/g, "'\\''") + "'";
    const block = `${prior && !prior.endsWith('\n') ? '\n' : ''}${BEGIN}\nexport PATH=${quote}:"$PATH"\n${END}\n`;
    steps.push({
      kind: 'rc-block',
      path: file,
      content: prior + block,
      mode: original.identity?.mode ?? 0o600,
      block,
      expectedOriginalHash: original.sha256 ?? null,
      original,
    });
  }
  for (const input of options.steps ?? []) {
    if (!['private-dir', 'owned-file'].includes(input.kind)) throw new Error('unsupported_client_step_kind');
    const callerFields =
      input.kind === 'private-dir'
        ? ['kind', 'path']
        : ['kind', 'path', 'content', 'mode', 'expectedOriginalHash', 'confirmation'];
    if (Reflect.ownKeys(input).some((key) => !callerFields.includes(key)))
      throw new Error('reserved_client_step_field');
    absolute(input.path);
    if (
      [prefix, shimDir, metadata(hudHome)].some((root) => input.path === root || input.path.startsWith(root + '/')) ||
      preserved.some((p) => p.path === input.path)
    )
      throw new Error('reserved_activation_target');
    if (input.kind === 'owned-file') {
      const state = observe(input.path);
      if (state.kind !== 'absent' && (!input.confirmation || input.expectedOriginalHash !== state.sha256))
        throw new Error('foreign_owned_file');
    }
    if (input.kind === 'private-dir') {
      const state = observe(input.path);
      if (state.kind !== 'absent') {
        if (state.kind !== 'directory' || state.identity.mode !== 0o700) throw new Error('unsafe_client_directory');
        continue;
      }
    }
    // Never carry caller-supplied journal/planner fields into internal actions.
    steps.push(
      input.kind === 'private-dir'
        ? { kind: 'private-dir', path: input.path }
        : {
            kind: 'owned-file',
            path: input.path,
            content: input.content,
            mode: input.mode,
            ...(Object.hasOwn(input, 'expectedOriginalHash')
              ? { expectedOriginalHash: input.expectedOriginalHash }
              : {}),
            ...(Object.hasOwn(input, 'confirmation') ? { confirmation: input.confirmation } : {}),
          }
    );
  }
  // Only the built-in generator can enter the reserved metadata subtree. Caller steps
  // above still cannot. Reused exact bytes become journalled shared ownership, not overwrite.
  if (integration) {
    const parent = path.join(metadata(hudHome), 'integrations');
    const state = observe(parent);
    if (state.kind !== 'absent' && (state.kind !== 'directory' || state.identity.mode !== 0o700))
      throw new Error('unsafe_integration_parent');
    if (state.kind === 'absent') steps.push({ kind: 'private-dir', path: parent });
    const root = path.join(parent, integration.integrationId);
    for (const generated of integration.steps) {
      if (!(generated.path === root || generated.path.startsWith(root + '/')))
        throw new Error('reserved_activation_target');
      const original = observe(generated.path);
      const identical =
        generated.kind === 'private-dir'
          ? original.kind === 'directory' && original.identity.mode === 0o700
          : original.kind === 'file' &&
            original.identity.mode === generated.mode &&
            original.sha256 === digest(generated.content);
      if (original.kind !== 'absent' && !identical) throw new Error('generated_integration_conflict');
      // Existing directories/files may only be reused when a prior receipt proves ownership.
      if (identical && !integrationOwner(hudHome, integration.integrationId, generated.path, original))
        throw new Error('generated_integration_foreign');
      steps.push({ ...generated, generated: true, reused: identical });
    }
  }
  const seen = new Set();
  for (const step of steps) {
    if (seen.has(step.path)) throw new Error('duplicate_activation_target');
    seen.add(step.path);
    const observed = observe(step.path);
    if (step.original && !same(step.original, observed)) throw new Error('target_changed_during_preview');
    step.original = observed;
    if (Object.hasOwn(step, 'expectedOriginalHash') && step.expectedOriginalHash !== (observed.sha256 ?? null))
      throw new Error('target_changed_during_preview');
    if (
      step.kind !== 'private-dir' &&
      (typeof step.content !== 'string' ||
        Buffer.byteLength(step.content) > MAX_FILE ||
        ![0o600, 0o700, step.original.identity?.mode].includes(step.mode))
    )
      throw new Error('invalid_step_content_or_mode');
    step.proposed =
      step.kind === 'private-dir'
        ? { kind: 'directory', mode: 0o700 }
        : { kind: 'file', sha256: digest(step.content), mode: step.mode };
  }
  const selector = path.join(prefix, 'current');
  const selectorOriginal = observe(selector);
  const history = activationHistory(hudHome);
  const seed = digest(json({ prefix, hudHome, shimDir, release, steps, selectorOriginal, history }));
  const transaction = uuid(seed);
  if (selectorValue(runtimeState.current) !== release) {
    const content = selectorBytes(release, transaction);
    steps.push({
      kind: 'selector',
      path: selector,
      content,
      mode: 0o600,
      original: selectorOriginal,
      proposed: { kind: 'file', sha256: digest(content), mode: 0o600 },
    });
  }
  const plan = {
    schemaVersion: 1,
    operation: 'install',
    transaction,
    runtimeDigest: release,
    releaseVersion,
    ...(integration
      ? { integrationId: integration.integrationId, plugin: integration.plugin, skillHash: integration.skillHash }
      : {}),
    history,
    prefix,
    hudHome,
    shimDir,
    publicNames: [...PUBLIC_NAMES],
    preserved,
    recoveryMetadata: {
      path: metadata(hudHome),
      original: recoveryState,
      proposed: { kind: 'directory', mode: 0o700 },
      retained: true,
    },
    preflight: [
      { check: 'linux-node', result: 'PASS' },
      { check: 'verified-receipt-backed-release', result: 'PASS' },
      { check: 'PATH', result: onPath ? 'present' : 'not present; rc edit is opt-in' },
    ],
    confirmations: steps.map((s) => ({
      path: s.path,
      operation: s.kind,
      proposed: s.proposed,
      ownerItem: s.confirmation ?? 'Confirm this exact target diff before apply.',
    })),
    actions: steps,
    recovery:
      'hud install restore --receipt RECEIPT; stop on conflicts. installation/ journals and backups are retained, including when HUD_HOME was absent. Releases are never purged.',
  };
  const backupSize = steps.reduce(
    (size, step) => size + (step.original.kind === 'file' ? Math.ceil((bytes(step.path).length * 4) / 3) : 0),
    0
  );
  if (steps.length > 128 || json(plan).length + backupSize + steps.length * 8192 > MAX_FILE)
    throw new Error('activation_receipt_capacity_exceeded');
  return { ...plan, planId: digest(json(plan)) };
}
function saveReceipt(file, receipt) {
  const state = observe(file);
  atomic(file, json(receipt), 0o600, state);
}
function journalPath(home, id) {
  return path.join(metadata(home), `${id}.json`);
}
function loadReceipt(file) {
  let value;
  try {
    value = JSON.parse(bytes(absolute(file)));
  } catch {
    throw new Error('invalid_activation_receipt');
  }
  if (
    value.schemaVersion !== 1 ||
    value.plan?.schemaVersion !== 1 ||
    !HASH.test(value.plan.planId ?? '') ||
    file !== journalPath(value.plan.hudHome, value.plan.transaction) ||
    !Array.isArray(value.journal)
  )
    throw new Error('foreign_activation_receipt');
  const { planId, ...body } = value.plan;
  if (digest(json(body)) !== planId) throw new Error('receipt_plan_integrity');
  return value;
}
function integrationOwner(home, id, target, state = null, excluding = null) {
  if (observe(metadata(home)).kind === 'absent') return false;
  for (const name of listNames(metadata(home), ACTIVATION_HISTORY_LIMIT + 32)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const file = path.join(metadata(home), name);
    if (file === excluding) continue;
    const other = loadReceipt(file);
    if (other.status === 'deactivated' || other.plan.integrationId !== id) continue;
    if (
      other.journal.some((entry) => {
        const step = other.plan.actions[entry.index];
        return (
          step.generated &&
          step.path === target &&
          !['restored', 'retained-shared'].includes(entry.phase) &&
          (!state || (entry.after && same(bare(entry.after), bare(state))))
        );
      })
    )
      return true;
  }
  return false;
}
function bootstrapMetadata(plan) {
  // Metadata is the documented retention exception. No managed file is changed yet.
  // It is self-describing even if interrupted before the transaction receipt exists.
  for (const file of [plan.hudHome, metadata(plan.hudHome)]) {
    const state = observe(file);
    if (state.kind === 'absent') {
      try {
        mkdir(file);
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
    const actual = observe(file);
    if (actual.kind !== 'directory' || actual.identity.mode !== 0o700) throw new Error('unsafe_installation_metadata');
  }
}
export function applyActivation(options, expected, hooks = {}) {
  const plan = planActivation(options);
  if (!HASH.test(expected ?? '') || plan.planId !== expected) throw new Error('stale_plan_preview_again');
  // Recheck all targets before the first write, not merely each one as it is reached.
  for (const step of plan.actions) assertState(step.path, step.original, true);
  bootstrapMetadata(plan);
  const bootstrappedHome = observe(plan.hudHome);
  const bootstrappedMetadata = observe(metadata(plan.hudHome));
  const file = journalPath(plan.hudHome, plan.transaction);
  return withActivationLocks(plan.prefix, plan.hudHome, file, () => {
    strictRuntime(plan.prefix, plan.runtimeDigest, true);
    hooks.checkpoint?.('before-history-recheck', -1, file);
    if (!same(activationHistory(plan.hudHome), plan.history))
      throw new Error('stale_plan_preview_again: activation_history_changed');
    for (const step of plan.actions) {
      if (step.path !== plan.hudHome || step.original.kind !== 'absent') assertState(step.path, step.original);
    }
    if (exists(file)) throw new Error('activation_already_attempted_restore_receipt');
    const receipt = {
      schemaVersion: 1,
      plan,
      status: 'applying',
      metadata: {
        phase: 'after',
        original: plan.recoveryMetadata.original,
        after: bootstrappedMetadata,
        retained: true,
      },
      journal: [],
      recovery: plan.recovery,
    };
    saveReceipt(file, receipt);
    try {
      hooks.checkpoint?.('metadata', -1, file);
      for (let i = 0; i < plan.actions.length; i++) {
        const step = plan.actions[i];
        assertState(plan.hudHome, bootstrappedHome);
        assertState(metadata(plan.hudHome), bootstrappedMetadata);
        for (const prior of receipt.journal) {
          if (prior.after?.kind === 'directory') assertState(plan.actions[prior.index].path, prior.after);
        }
        // HUD_HOME was materialized to house the retained recovery metadata.
        if (step.path === plan.hudHome && step.kind === 'private-dir') continue;
        assertState(step.path, step.original);
        const backup = step.original.kind === 'file' ? bytes(step.path).toString('base64') : null;
        const entry = {
          index: i,
          before: step.generated ? { kind: 'absent', parents: step.original.parents } : step.original,
          backup,
          phase: 'before',
          after: null,
        };
        receipt.journal.push(entry);
        saveReceipt(file, receipt);
        hooks.checkpoint?.('before', i, file);
        assertState(step.path, step.original);
        if (!step.reused) {
          if (step.kind === 'private-dir') mkdir(step.path);
          else atomic(step.path, Buffer.from(step.content), step.mode, step.original);
        }
        hooks.checkpoint?.('mutated', i, file);
        entry.after = observe(step.path);
        entry.phase = 'after';
        saveReceipt(file, receipt);
        if (step.kind === 'selector') strictRuntime(plan.prefix, plan.runtimeDigest, true);
        hooks.checkpoint?.('after', i, file);
      }
      receipt.status = 'active';
      saveReceipt(file, receipt);
      return { status: 'ACTIVATED', receipt: file, runtimeDigest: plan.runtimeDigest };
    } catch (error) {
      error.message += `; restore_receipt=${file}`;
      throw error;
    }
  });
}
function matchesProposed(state, proposed) {
  return (
    state.kind === proposed.kind &&
    state.identity?.mode === proposed.mode &&
    (state.kind !== 'file' || state.sha256 === proposed.sha256)
  );
}
/** A newer receipt can prove that an earlier exact installed value was restored
 * through an atomic rename (new inode). Same bytes alone never authorize reversal.
 */
function recordedRestoration(receipt, file, expected, current) {
  for (const name of listNames(metadata(receipt.plan.hudHome), ACTIVATION_HISTORY_LIMIT + 32)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const candidate = loadReceipt(path.join(metadata(receipt.plan.hudHome), name));
    if (candidate.plan.prefix !== receipt.plan.prefix) continue;
    for (const entry of candidate.journal) {
      const step = candidate.plan.actions[entry.index];
      if (
        entry.phase === 'restored' &&
        step.path === file &&
        same(bare(entry.before), bare(expected)) &&
        entry.restoredState &&
        same(bare(entry.restoredState), bare(current))
      )
        return true;
    }
  }
  return false;
}
/** Plan reversal from a durable journal, including a crash between mutation and after record. */
export function planDeactivation(receiptFile) {
  runtime();
  const receipt = loadReceipt(receiptFile);
  const actions = [];
  const conflicts = [];
  for (const entry of [...receipt.journal].reverse()) {
    if (['restored', 'retained-shared'].includes(entry.phase)) continue;
    const step = receipt.plan.actions[entry.index];
    if (
      step.generated &&
      integrationOwner(receipt.plan.hudHome, receipt.plan.integrationId, step.path, null, receiptFile)
    ) {
      actions.push({ index: entry.index, path: step.path, shared: true });
      continue;
    }
    let current;
    try {
      current = observe(step.path);
    } catch (e) {
      conflicts.push({ path: step.path, reason: e.message });
      continue;
    }
    const alreadyRestored =
      entry.restoreIntent &&
      (entry.restoreTarget
        ? matchesProposed(current, entry.restoreTarget)
        : current.kind === entry.before.kind &&
          (current.kind !== 'file' ||
            (current.sha256 === entry.before.sha256 && current.identity.mode === entry.before.identity.mode)));
    if (alreadyRestored) {
      actions.push({ index: entry.index, path: step.path, original: current, restore: entry.before, reconcile: true });
      continue;
    }
    if (same(bare(current), bare(entry.before))) continue; // intent was durable but mutation did not happen
    const intactBlock =
      step.kind === 'rc-block' &&
      current.kind === 'file' &&
      bytes(step.path).toString('utf8').split(step.block).length === 2;
    if (
      !intactBlock &&
      (entry.after
        ? !same(bare(current), bare(entry.after)) && !recordedRestoration(receipt, step.path, entry.after, current)
        : !matchesProposed(current, step.proposed))
    ) {
      conflicts.push({ path: step.path, reason: 'changed_since_activation' });
      continue;
    }
    actions.push({ index: entry.index, path: step.path, original: current, restore: entry.before });
  }
  const body = {
    schemaVersion: 1,
    operation: 'uninstall',
    receipt: absolute(receiptFile),
    receiptHash: digest(bytes(receiptFile)),
    runtimeDigest: receipt.plan.runtimeDigest,
    actions,
    conflicts,
    recovery: receipt.plan.recovery,
  };
  return { ...body, planId: digest(json(body)) };
}
export function restoreActivation(receiptFile, expected, hooks = {}) {
  const first = planDeactivation(receiptFile);
  if (expected && expected !== first.planId) throw new Error('stale_plan_preview_again');
  const receipt = loadReceipt(receiptFile);
  if (hooks.recoverLocks !== false)
    recoverActivationLocks(receipt.plan.prefix, receipt.plan.hudHome, absolute(receiptFile));
  else refuseActivationLock(receipt.plan.prefix, receipt.plan.hudHome);
  return withActivationLocks(receipt.plan.prefix, receipt.plan.hudHome, absolute(receiptFile), () => {
    const plan = planDeactivation(receiptFile);
    if (plan.planId !== first.planId) throw new Error('stale_plan_preview_again');
    if (plan.conflicts.length)
      return { status: 'CONFLICT', conflicts: plan.conflicts, receipt: receiptFile, recovery: plan.recovery };
    for (const action of plan.actions) {
      const entry = receipt.journal.find((j) => j.index === action.index);
      const step = receipt.plan.actions[action.index];
      if (action.shared) {
        entry.phase = 'retained-shared';
        saveReceipt(receiptFile, receipt);
        continue;
      }
      assertState(step.path, action.original);
      if (!action.reconcile) {
        let data = null;
        const mode = entry.before.identity?.mode ?? step.mode;
        if (step.kind === 'rc-block') {
          const current = bytes(step.path).toString('utf8');
          if (current.split(step.block).length !== 2) throw new Error('rc_block_conflict');
          const restored = Buffer.from(current.replace(step.block, ''));
          if (restored.length || entry.before.kind === 'file') data = restored;
        } else if (entry.before.kind === 'file') {
          data = Buffer.from(entry.backup, 'base64');
          if (digest(data) !== entry.before.sha256) throw new Error('backup_integrity_mismatch');
        }
        entry.restoreIntent = true;
        entry.restoreTarget = data === null ? { kind: 'absent' } : { kind: 'file', sha256: digest(data), mode };
        saveReceipt(receiptFile, receipt);
        if (data !== null) atomic(step.path, data, mode, action.original);
        else if (step.kind === 'private-dir') {
          // New keys/history/results always win over directory cleanup.
          try {
            remove(step.path, true);
          } catch (error) {
            if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
          }
        } else remove(step.path);
        hooks.checkpoint?.('restore-mutated', action.index, receiptFile);
      }
      if (step.kind === 'selector') {
        const directory = new Directory(receipt.plan.prefix, true);
        try {
          inspectPrefix(directory, true);
        } finally {
          directory.close();
        }
      }
      entry.restoredState = observe(step.path);
      entry.phase = 'restored';
      saveReceipt(receiptFile, receipt);
      hooks.checkpoint?.('restored', action.index, receiptFile);
    }
    receipt.status = 'deactivated';
    saveReceipt(receiptFile, receipt);
    return {
      status: 'deactivated; release retained',
      receipt: receiptFile,
      runtimeDigest: receipt.plan.runtimeDigest,
      explanation:
        'Immutable releases, recorded owners and installation recovery records are retained; no garbage collection.',
    };
  });
}
