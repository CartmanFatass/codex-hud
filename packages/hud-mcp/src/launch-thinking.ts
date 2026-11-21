import { spawn } from 'node:child_process';
import { isModelToken, readModelListCache } from '../../../src/roles/model-discovery.js';
import type { RolePlace } from '../../../src/roles/roster.js';

const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
type Model = { provider: string; id: string; reasoning: boolean; thinkingLevelMap?: Record<string, string | null> };
const probes = new Map<string, Promise<string[] | undefined>>();

// Claude 2.1.330 and agy --help list these --effort values. Only map known models.
const cliLevels = ['low', 'medium', 'high', 'xhigh', 'max'];
const cliModels: Record<string, { models: string[]; thinking: string[] }[]> = {
  claude: [{ models: ['fable', 'opus', 'sonnet'], thinking: cliLevels }],
  agy: [{ models: ['gemini-4-argon-high', 'gemini-4-hydrogen-high'], thinking: cliLevels }],
  // Codex 0.171.0's bundled model catalog documents the levels accepted by
  // model_reasoning_effort per model (the config schema itself accepts strings).
  codex: [
    { models: ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol',
      'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-daybreak-blue-latest', 'gpt-daybreak-red-latest'], thinking: [...cliLevels, 'ultra'] },
    { models: ['gpt-6-luna', 'gpt-5.6-luna', 'codex-auto-review'], thinking: cliLevels },
    { models: ['gpt-5.5'], thinking: cliLevels.slice(0, 4) },
  ],
};

export function launchThinking(hudHome: string, place: Pick<RolePlace, 'harness' | 'agent'>, model: string | null) {
  if (!model || !isModelToken(model)) return;
  if (place.harness === 'cli' && place.agent) return cliModels[place.agent]?.find((fact) => fact.models.includes(model))?.thinking;
  if (place.harness !== 'pi') return;
  // The picker's fact can prove a model only supports off. For exact levels,
  // ask pi for the selected model's metadata, offline and without a session.
  const fact = readModelListCache(hudHome)?.piFacts?.[model];
  if (fact?.[2] === false) return ['off'];
  let pending = probes.get(model);
  if (!pending) {
    pending = probe(model);
    probes.set(model, pending);
    void pending.then(() => setTimeout(() => probes.delete(model), 30_000).unref());
  }
  return pending;
}

function probe(model: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    const child = spawn('pi', ['--mode', 'rpc', '--no-session', '-ne', '-ns', '--model', model], {
      cwd: '/', env: { ...process.env, PI_OFFLINE: '1' }, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = '';
    let result: string[] | undefined;
    const stop = () => { child.stdin.destroy(); child.stdout.destroy(); child.kill('SIGKILL'); };
    const timer = setTimeout(stop, 3000);
    child.stdin.on('error', stop);
    child.once('error', stop);
    child.once('close', () => { clearTimeout(timer); resolve(result); });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 64 * 1024) return stop();
      let newline;
      while ((newline = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        try {
          const reply = JSON.parse(line);
          if (reply.id !== 'hud-thinking') continue;
          const m: Model | undefined = reply.data?.model;
          if (m && (model === `${m.provider}/${m.id}` || model === m.id) && typeof m.reasoning === 'boolean') {
            result = m.reasoning ? levels.filter((level, i) => {
              const mapped = m.thinkingLevelMap?.[level];
              return mapped !== null && (i < 5 || mapped !== undefined);
            }) : ['off'];
          }
          return stop();
        } catch { /* Ignore startup prose. */ }
      }
    });
    child.stdin.write('{"id":"hud-thinking","type":"get_state"}\n');
  });
}

export function nearestThinking(wanted: string, supported: string[]) {
  const rank = (level: string) => level === 'ultra' ? levels.length : levels.indexOf(level);
  const index = rank(wanted);
  if (index < 0) return supported[0];
  return supported.reduce<string | undefined>((best, candidate) =>
    !best || Math.abs(rank(candidate) - index) < Math.abs(rank(best) - index) ? candidate : best, undefined);
}
