import type { ExpAccount } from '../../exp-config.js';
import type { FooterContext } from './footer-host.js';

/** Attribute only the native Anthropic endpoint, with a known API-key credential route. */
export function piExpAccount(ctx: FooterContext | null | undefined): ExpAccount | undefined {
  const model = ctx?.model;
  if (model?.provider === 'oapi') return 'openai-api';
  if (
    model?.provider !== 'anthropic' ||
    model.api !== 'anthropic-messages' ||
    (model.baseUrl !== 'https://api.anthropic.com' && model.baseUrl !== 'https://api.anthropic.com/')
  )
    return;
  try {
    const registry = ctx?.modelRegistry;
    if (registry?.isUsingOAuth(model) !== false || registry.getRegisteredProviderIds?.().includes('anthropic')) return;
    // Pi's false includes missing auth, raw token env vars, and federation. Use only credential-free status metadata.
    const status = registry.getProviderAuthStatus?.('anthropic');
    if (
      status?.configured === true &&
      (['stored', 'runtime', 'models_json_key'].includes(status.source ?? '') ||
        (status.source === 'environment' && status.label === 'ANTHROPIC_API_KEY'))
    )
      return 'anthropic-api';
  } catch {
    // Missing or unavailable host evidence is not an API-key route.
  }
}
