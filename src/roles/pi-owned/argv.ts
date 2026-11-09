/** Structured herdr argv; never quote or join these elements into a shell command. */
import { join } from 'node:path';
import {
  HELPER_SKILL,
  ROLE_TOOLS,
  WORKER_ENTRY,
  canonicalPath,
  refuse,
  singleLine,
  slotPaths,
  type SlotContract,
} from './contracts.js';

export function buildWorkerArgv(contract: SlotContract, agentName: string, pane: string): string[] {
  if (
    !singleLine(agentName) ||
    !singleLine(pane) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(agentName) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(pane)
  )
    refuse('invalid_contract', 'locator');
  if (!contract.herdr_integration || !canonicalPath(contract.herdr_integration.path))
    refuse('herdr_pi_integration_missing', 'herdr integration install pi');
  const args = [
    'agent',
    'start',
    agentName,
    '--kind',
    'pi',
    '--pane',
    pane,
    '--timeout',
    '30000',
    '--',
    '-ne',
    '-ns',
    '-np',
    '--no-themes',
    '--no-mcp',
    '--no-approve',
    '-e',
    join(contract.release.root, WORKER_ENTRY),
    '-e',
    contract.herdr_integration.path,
    '--hud-role-contract',
    slotPaths(contract.task_dir, contract.slot).contract,
    '--hud-role-file',
    contract.role_resource.path,
    '--model',
    contract.model,
    '--thinking',
    contract.effort,
    '--tools',
    ROLE_TOOLS[contract.role],
    '--session-dir',
    contract.session_dir,
    '--session-id',
    contract.session_id,
    '--tui-mode',
    'regular',
  ];
  if (contract.role === 'implementer') args.push('--skill', join(contract.release.root, HELPER_SKILL));
  if (args.some((arg) => !singleLine(arg))) refuse('invalid_contract', 'argv');
  return args;
}
