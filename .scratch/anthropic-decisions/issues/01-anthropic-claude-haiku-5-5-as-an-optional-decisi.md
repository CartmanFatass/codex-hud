# 01: Anthropic (Claude Haiku 5.5) as an optional Decision API provider

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Owner 2026-11-24: one API key store ($HUD_HOME/credentials.env) serves every project; the Anthropic key and the OpenAI API key are optional model providers wherever HUD needs model judgement. HUD's Decision API has Gemini, OpenAI and TypeSafe (src/jev/decide.ts decideProviderId, docs/reference.md around 'Automatic fallback'). Add `anthropic` as a fourth provider: reads ANTHROPIC_API_KEY from credentials.env (readCredentialsEnv in src/jev/ask/config.ts, never another location), model claude-haiku-5-5, structured output through the Messages API `output_config: {format: {type: 'json_schema', ...}}` with `output_config.effort: 'low'`, using the official `@anthropic-ai/sdk` loaded lazily (dynamic import only when the provider is used, so HUD start-up and other providers pay nothing). Settings -> Models offers it as a primary choice; automatic fallback order becomes Gemini -> OpenAI -> Anthropic -> TypeSafe; a `stop_reason: 'refusal'` counts as a refused answer (no fallback), as other providers' refusals do. Defaults unchanged: nothing switches to Anthropic unless chosen or used as fallback. Do not log or print key values; name variables only.

- [ ] decideProviderId and the fallback chain accept anthropic; missing key reports ANTHROPIC_API_KEY by name
- [ ] A unit test with a stubbed SDK client covers a valid decision, a refusal and a timeout
- [ ] Settings -> Models lists Anthropic; docs/reference.md names it in the provider list and fallback order
- [ ] Without the anthropic provider selected or needed, @anthropic-ai/sdk is never imported (test or import-graph check)
- [ ] The land gate passes

## Comments
