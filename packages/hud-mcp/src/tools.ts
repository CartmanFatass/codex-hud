import { validateRequestKey } from '../../../src/core/execution.js';
import { object } from './io.js';
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
const string = { type: 'string', minLength: 1 };
const mode = { type: 'string', enum: ['visible', 'headless'] };
function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  extra: Record<string, unknown> = {}
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false, ...extra },
  };
}
const target = {
  oneOf: [
    { required: ['linkId'], not: { required: ['runId'] } },
    { required: ['runId'], not: { required: ['linkId'] } },
  ],
};
export const TOOLS: ToolDefinition[] = [
  tool(
    'delegate_spawn',
    'Accept one headless delegated run; retry the same request_key only to replay that intent.',
    {
      backend: string,
      role: string,
      brief: string,
      cwd: string,
      mode,
      request_key: { ...string, maxLength: 256 },
      name: string,
      model: string,
      effort: string,
      layout: { type: 'string', enum: ['tab', 'split'] },
      predecessor: string,
    },
    ['backend', 'role', 'brief', 'cwd', 'mode', 'request_key']
  ),
  tool(
    'delegate_resume',
    'Accept a new headless run for a bound delegated session.',
    { linkId: string, mode, prompt: { type: 'string' }, request_key: { ...string, maxLength: 256 } },
    ['linkId', 'mode', 'request_key']
  ),
  tool(
    'delegate_wait',
    'Read events for one fixed run (not implemented).',
    {
      linkId: string,
      runId: string,
      afterSeq: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      until: {
        type: 'array',
        items: { type: 'string', enum: ['report', 'run_terminal', 'uncertain'] },
      },
      timeoutMs: { type: 'integer', minimum: 0, maximum: 120000 },
    },
    [],
    target
  ),
  tool(
    'delegate_status',
    'Read delegated run status (not implemented).',
    { linkId: string, runId: string },
    [],
    target
  ),
  tool(
    'delegate_cancel',
    'Accept cancellation for a run (not implemented).',
    { runId: string, grace: { type: 'number', minimum: 0 } },
    ['runId']
  ),
  tool(
    'delegate_whoami',
    'Bind this run using its launch environment claim or parameter fallback.',
    { claim: string },
    []
  ),
  tool(
    'delegate_report',
    'Submit a report for the explicitly identified run from its current bound child.',
    {
      runId: string,
      status: { type: 'string', enum: ['completed', 'failed', 'blocked', 'interrupted'] },
      summary: { type: 'string' },
      reportPath: string,
    },
    ['runId', 'status', 'summary']
  ),
];
function valid(value: unknown, schema: Record<string, unknown>): boolean {
  if (schema.type === 'string')
    return (
      typeof value === 'string' &&
      (schema.minLength === undefined || [...value].length >= (schema.minLength as number)) &&
      (schema.maxLength === undefined || [...value].length <= (schema.maxLength as number)) &&
      (!Array.isArray(schema.enum) || schema.enum.includes(value))
    );
  if (schema.type === 'integer' || schema.type === 'number')
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      (schema.type !== 'integer' || Number.isSafeInteger(value)) &&
      (schema.minimum === undefined || value >= (schema.minimum as number)) &&
      (schema.maximum === undefined || value <= (schema.maximum as number))
    );
  if (schema.type === 'array')
    return (
      Array.isArray(value) &&
      value.length >= ((schema.minItems as number) || 0) &&
      (!schema.uniqueItems || new Set(value).size === value.length) &&
      value.every((v) => valid(v, schema.items as Record<string, unknown>))
    );
  return false;
}
export function validateToolArguments(definition: ToolDefinition, args: unknown): boolean {
  if (!object(args)) return false;
  const properties = definition.inputSchema.properties as Record<string, Record<string, unknown>>;
  if ((definition.inputSchema.required as string[]).some((k) => !Object.hasOwn(args, k))) return false;
  if (Object.entries(args).some(([k, v]) => !Object.hasOwn(properties, k) || !valid(v, properties[k]))) return false;
  if (definition.name === 'delegate_wait' || definition.name === 'delegate_status')
    if (Object.hasOwn(args, 'runId') === Object.hasOwn(args, 'linkId')) return false;
  if (Object.hasOwn(args, 'request_key'))
    try {
      validateRequestKey(args.request_key as string);
    } catch {
      return false;
    }
  return true;
}
