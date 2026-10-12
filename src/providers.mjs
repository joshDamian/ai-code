// @ts-check
// Providers: where a Claude session's API calls go, and what each one is billed at.
//
// A provider is an environment profile for the Claude Code binary the Agent SDK runs.
// The subscription provider adds nothing and lets the person's own login answer; a
// hosted provider points ANTHROPIC_BASE_URL at someone else's Anthropic-compatible
// endpoint and pins every model alias to the model chosen. Nothing routes between
// them: the person picks one per session.

// A session must not inherit the Anthropic routing a person set for their own
// terminal, or a subscription login silently bills a third-party endpoint instead.
// The terminal strips the same set, so a `claude` typed there bills the same way.
export const AMBIENT_ROUTING_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  // FireConnect sends the Fireworks key in a header rather than as a token.
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_EFFORT_LEVEL',
];

// The providers reached through someone else's Anthropic-compatible endpoint. Every
// base URL is the one claude appends `/v1/messages` to. The key goes in
// ANTHROPIC_AUTH_TOKEN: Claude Code rejects an ANTHROPIC_API_KEY it has not approved.
const HOSTED = {
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', keyEnv: 'DEEPSEEK_API_KEY' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api', keyEnv: 'OPENROUTER_API_KEY' },
  fireworks: { label: 'Fireworks', baseUrl: 'https://api.fireworks.ai/inference', keyEnv: 'FIREWORKS_API_KEY' },
};

/** @param {NodeJS.ProcessEnv} [base] */
export function cleanEnv(base = process.env) {
  /** @type {Record<string, string|undefined>} */
  const env = { ...base };
  for (const k of AMBIENT_ROUTING_VARS) delete env[k];
  // A dev server the agent starts must not land on the port this server holds.
  delete env.PORT;
  return env;
}

/**
 * The variables that send a session to its provider, on top of cleanEnv().
 * @param {import('./contract.mjs').Provider} provider
 * @param {import('./contract.mjs').Model | null} model
 */
export function providerEnv(provider, model) {
  const hosted = HOSTED[/** @type {keyof typeof HOSTED} */ (provider.kind)];
  if (!hosted) return { BENCH_PROVIDER: provider.id };
  const keyEnv = provider.config.apiKeyEnv || hosted.keyEnv;
  const key = process.env[keyEnv];
  if (!key) throw Object.assign(new Error(`Missing ${keyEnv} for the ${hosted.label} provider`), { code: 'AUTH_FAILURE' });
  const mid = model ? invocationId(model) : undefined;
  return {
    BENCH_PROVIDER: provider.id,
    ANTHROPIC_BASE_URL: hosted.baseUrl,
    ANTHROPIC_AUTH_TOKEN: key,
    ...(mid
      ? {
          ANTHROPIC_MODEL: mid,
          ANTHROPIC_DEFAULT_OPUS_MODEL: mid,
          ANTHROPIC_DEFAULT_SONNET_MODEL: mid,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: mid,
          CLAUDE_CODE_SUBAGENT_MODEL: mid,
        }
      : {}),
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(provider.config.autoCompactWindow || 786432),
    // Anthropic's experimental betas are not served by these endpoints. One of them,
    // inline tools, replays a conversation's deferred-tool history as `tool_definition`
    // blocks, and DeepSeek answers 422 to those - so a session started on the Claude
    // login could not be continued here until this was set.
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
  };
}

/** @param {import('./contract.mjs').Model} m */
export const invocationId = (m) => m.invocation_model_id || m.provider_model_id || m.name;

/** Whether a provider can run right now, and why not. @param {import('./contract.mjs').Provider} p */
export function providerReady(p) {
  if (!p.enabled) return { ready: false, reason: 'Disabled' };
  const hosted = HOSTED[/** @type {keyof typeof HOSTED} */ (p.kind)];
  if (!hosted) return p.kind === 'claude-code' ? { ready: true, reason: null } : { ready: false, reason: `Unknown kind ${p.kind}` };
  const keyEnv = p.config.apiKeyEnv || hosted.keyEnv;
  return process.env[keyEnv] ? { ready: true, reason: null } : { ready: false, reason: `Set ${keyEnv} in the server's environment` };
}

// The model catalogs. `quality`, `speed` and `capabilities` are left from the routing
// era and read by nothing; the prices are what the usage numbers are computed from.
const CLAUDE_MODELS = [
  { id: 'anthropic:claude-opus-5', name: 'claude-opus-5', displayName: 'Claude Opus 5', providerModelId: 'claude-opus-5', invocationModelId: 'claude-opus-5', capabilities: ['planning', 'coding', 'review', 'repair'], speed: 7, quality: 9.5, contextLength: 1000000, reasoning: 'frontier', toolUse: true, streaming: true, inputCostPerMTok: 5, cacheReadCostPerMTok: 0.5, cacheWriteCostPerMTok: 10, outputCostPerMTok: 25, billingMode: 'subscription', pricingSource: 'Anthropic official pricing', pricingUpdatedAt: '2026-08-24' },
  { id: 'anthropic:claude-opus-5-5', name: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', providerModelId: 'claude-opus-5-5', invocationModelId: 'claude-opus-5-5', capabilities: ['planning', 'coding', 'review', 'repair'], speed: 7, quality: 10, contextLength: 1000000, reasoning: 'frontier', toolUse: true, streaming: true, inputCostPerMTok: 4, cacheReadCostPerMTok: 0.2, cacheWriteCostPerMTok: 8, outputCostPerMTok: 20, billingMode: 'subscription', pricingSource: 'Anthropic official pricing', pricingUpdatedAt: '2026-09-27' },
  { id: 'anthropic:claude-opus-4-8', name: 'claude-opus-4-8', displayName: 'Claude Opus 4.8', providerModelId: 'claude-opus-4-8', invocationModelId: 'claude-opus-4-8', capabilities: ['planning', 'coding', 'review', 'repair'], speed: 6, quality: 9.5, contextLength: 1000000, reasoning: 'frontier', toolUse: true, streaming: true, inputCostPerMTok: 5, cacheReadCostPerMTok: 0.5, cacheWriteCostPerMTok: 10, outputCostPerMTok: 25, billingMode: 'subscription', pricingSource: 'Anthropic official pricing', pricingUpdatedAt: '2026-08-24' },
  { id: 'anthropic:claude-sonnet-5', name: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', providerModelId: 'claude-sonnet-5', invocationModelId: 'claude-sonnet-5', capabilities: ['planning', 'coding', 'review', 'repair'], speed: 9, quality: 8.5, contextLength: 1000000, reasoning: 'strong', toolUse: true, streaming: true, inputCostPerMTok: 2, cacheReadCostPerMTok: 0.2, cacheWriteCostPerMTok: 4, outputCostPerMTok: 10, billingMode: 'subscription', pricingSource: 'Anthropic official pricing', pricingUpdatedAt: '2026-08-10' },
  { id: 'anthropic:claude-sonnet-5-5', name: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', providerModelId: 'claude-sonnet-5-5', invocationModelId: 'claude-sonnet-5-5', capabilities: ['planning', 'coding', 'review', 'repair'], speed: 9, quality: 9, contextLength: 1000000, reasoning: 'strong', toolUse: true, streaming: true, inputCostPerMTok: 2, cacheReadCostPerMTok: 0.2, cacheWriteCostPerMTok: 4, outputCostPerMTok: 10, billingMode: 'subscription', pricingSource: 'Anthropic official pricing', pricingUpdatedAt: '2026-10-03' },
  { id: 'anthropic:claude-sonnet-4-6', name: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', providerModelId: 'claude-sonnet-4-6', invocationModelId: 'claude-sonnet-4-6', capabilities: ['planning', 'coding', 'review', 'repair'], speed: 8, quality: 8, contextLength: 1000000, reasoning: 'strong', toolUse: true, streaming: true, inputCostPerMTok: 3, cacheReadCostPerMTok: 0.3, cacheWriteCostPerMTok: 6, outputCostPerMTok: 15, billingMode: 'subscription', pricingSource: 'Anthropic official pricing', pricingUpdatedAt: '2026-05-12' },
  { id: 'anthropic:claude-haiku-4-5-20251001', name: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5', providerModelId: 'claude-haiku-4-5-20251001', invocationModelId: 'claude-haiku-4-5-20251001', capabilities: ['planning', 'coding', 'review', 'repair'], speed: 10, quality: 7, contextLength: 200000, reasoning: 'moderate', toolUse: true, streaming: true, inputCostPerMTok: 1, cacheReadCostPerMTok: 0.1, cacheWriteCostPerMTok: 2, outputCostPerMTok: 5, billingMode: 'subscription', pricingSource: 'Anthropic official pricing', pricingUpdatedAt: '2026-10-05' },
  { id: 'anthropic:claude-fable-5-1', name: 'claude-fable-5-1', displayName: 'Claude Fable 5.1', providerModelId: 'claude-fable-5-1', invocationModelId: 'claude-fable-5-1', capabilities: ['planning', 'coding', 'review', 'repair'], speed: 5, quality: 10, contextLength: 1000000, reasoning: 'frontier', toolUse: true, streaming: true, inputCostPerMTok: 10, cacheReadCostPerMTok: 0.25, cacheWriteCostPerMTok: 20, outputCostPerMTok: 50, billingMode: 'subscription', pricingSource: 'Anthropic official pricing', pricingUpdatedAt: '2026-09-27' },
];

const DEEPSEEK_MODELS = [
  { id: 'deepseek:deepseek-flash', name: 'deepseek-flash', displayName: 'DeepSeek V4.1 Flash', providerModelId: 'deepseek-flash', invocationModelId: 'deepseek-flash', capabilities: ['planning', 'coding', 'review', 'repair'], speed: 10, quality: 7, contextLength: 1000000, reasoning: 'moderate', toolUse: true, streaming: true, inputCostPerMTok: 0.15, outputCostPerMTok: 0.6, cacheReadCostPerMTok: 0.003, peakInputCostPerMTok: 0.3, peakOutputCostPerMTok: 1.2, peakCacheReadCostPerMTok: 0.006, billingMode: 'api', pricingSource: 'DeepSeek official pricing', pricingUpdatedAt: '2026-09-21' },
  { id: 'deepseek:deepseek-v4-pro', name: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', providerModelId: 'deepseek-v4-pro', invocationModelId: 'deepseek-v4-pro', capabilities: ['planning', 'coding', 'review', 'repair'], speed: 7, quality: 8, contextLength: 1000000, reasoning: 'strong', toolUse: true, streaming: true, inputCostPerMTok: 0.66, outputCostPerMTok: 1.98, cacheReadCostPerMTok: 0.022, peakInputCostPerMTok: 1.32, peakOutputCostPerMTok: 3.96, peakCacheReadCostPerMTok: 0.044, billingMode: 'api', pricingSource: 'DeepSeek official pricing', pricingUpdatedAt: '2026-09-21' },
];

const OPENROUTER_MODELS = [
  { id: 'openrouter:anthropic/claude-opus-5', name: 'claude-opus-5', displayName: 'Claude Opus 5', providerModelId: 'anthropic/claude-opus-5', invocationModelId: 'anthropic/claude-opus-5', capabilities: ['planning', 'coding', 'review', 'repair'], speed: 7, quality: 9.5, contextLength: 1000000, reasoning: 'frontier', toolUse: true, streaming: true, inputCostPerMTok: 5, outputCostPerMTok: 25, cacheReadCostPerMTok: 0.5, cacheWriteCostPerMTok: 10, billingMode: 'api', pricingSource: 'OpenRouter pricing', pricingUpdatedAt: '2026-09-24' },
  { id: 'openrouter:anthropic/claude-opus-4.8', name: 'claude-opus-4.8', displayName: 'Claude Opus 4.8', providerModelId: 'anthropic/claude-opus-4.8', invocationModelId: 'anthropic/claude-opus-4.8', capabilities: ['planning', 'coding', 'review', 'repair'], speed: 6, quality: 9.5, contextLength: 1000000, reasoning: 'frontier', toolUse: true, streaming: true, inputCostPerMTok: 5, outputCostPerMTok: 25, cacheReadCostPerMTok: 0.5, cacheWriteCostPerMTok: 10, billingMode: 'api', pricingSource: 'OpenRouter pricing', pricingUpdatedAt: '2026-09-24' },
  { id: 'openrouter:anthropic/claude-sonnet-5', name: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', providerModelId: 'anthropic/claude-sonnet-5', invocationModelId: 'anthropic/claude-sonnet-5', capabilities: ['planning', 'coding', 'review', 'repair'], speed: 9, quality: 8.5, contextLength: 1000000, reasoning: 'strong', toolUse: true, streaming: true, inputCostPerMTok: 2, outputCostPerMTok: 10, cacheReadCostPerMTok: 0.2, cacheWriteCostPerMTok: 4, billingMode: 'api', pricingSource: 'OpenRouter pricing', pricingUpdatedAt: '2026-09-24' },
  { id: 'openrouter:anthropic/claude-sonnet-4.6', name: 'claude-sonnet-4.6', displayName: 'Claude Sonnet 4.6', providerModelId: 'anthropic/claude-sonnet-4.6', invocationModelId: 'anthropic/claude-sonnet-4.6', capabilities: ['planning', 'coding', 'review', 'repair'], speed: 8, quality: 8, contextLength: 1000000, reasoning: 'strong', toolUse: true, streaming: true, inputCostPerMTok: 3, outputCostPerMTok: 15, cacheReadCostPerMTok: 0.3, cacheWriteCostPerMTok: 6, billingMode: 'api', pricingSource: 'OpenRouter pricing', pricingUpdatedAt: '2026-09-24' },
  { id: 'openrouter:anthropic/claude-haiku-4.5', name: 'claude-haiku-4.5', displayName: 'Claude Haiku 4.5', providerModelId: 'anthropic/claude-haiku-4.5', invocationModelId: 'anthropic/claude-haiku-4.5', capabilities: ['planning', 'coding', 'review', 'repair'], speed: 10, quality: 7, contextLength: 200000, reasoning: 'moderate', toolUse: true, streaming: true, inputCostPerMTok: 1, outputCostPerMTok: 5, cacheReadCostPerMTok: 0.1, cacheWriteCostPerMTok: 2, billingMode: 'api', pricingSource: 'OpenRouter pricing', pricingUpdatedAt: '2026-09-24' },
  { id: 'openrouter:google/gemini-2.5-pro', name: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', providerModelId: 'google/gemini-2.5-pro', invocationModelId: 'google/gemini-2.5-pro', capabilities: ['coding'], speed: 8, quality: 9, contextLength: 1000000, reasoning: 'strong', toolUse: true, streaming: true, inputCostPerMTok: 1.25, outputCostPerMTok: 10, billingMode: 'api', pricingSource: 'OpenRouter pricing', pricingUpdatedAt: '2026-09-24' },
  { id: 'openrouter:google/gemini-2.5-flash', name: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', providerModelId: 'google/gemini-2.5-flash', invocationModelId: 'google/gemini-2.5-flash', capabilities: ['coding'], speed: 10, quality: 8, contextLength: 1000000, reasoning: 'moderate', toolUse: true, streaming: true, inputCostPerMTok: 0.15, outputCostPerMTok: 0.6, billingMode: 'api', pricingSource: 'OpenRouter pricing', pricingUpdatedAt: '2026-09-24' },
  { id: 'openrouter:meta-llama/llama-4-maverick', name: 'llama-4-maverick', displayName: 'Llama 4 Maverick', providerModelId: 'meta-llama/llama-4-maverick', invocationModelId: 'meta-llama/llama-4-maverick', capabilities: ['coding'], speed: 9, quality: 8, contextLength: 1000000, reasoning: 'moderate', toolUse: true, streaming: true, inputCostPerMTok: 0.2, outputCostPerMTok: 0.6, billingMode: 'api', pricingSource: 'OpenRouter pricing', pricingUpdatedAt: '2026-09-24' },
  { id: 'openrouter:qwen/qwen3-235b-a22b', name: 'qwen3-235b', displayName: 'Qwen 3 235B', providerModelId: 'qwen/qwen3-235b-a22b', invocationModelId: 'qwen/qwen3-235b-a22b', capabilities: ['coding'], speed: 7, quality: 9, contextLength: 131072, reasoning: 'strong', toolUse: true, streaming: true, inputCostPerMTok: 0.7, outputCostPerMTok: 2.8, billingMode: 'api', pricingSource: 'OpenRouter pricing', pricingUpdatedAt: '2026-09-24' },
];

const FIREWORKS_MODELS = [
  // FireRouter is not a model but a per-turn router across the serverless models
  // below, billed at whatever model it routes to. Its catalog row is a fiction the
  // scorer needs: pricing is pooled from its likely targets (GLM 5.3 through Kimi
  // K3), `quality` sits below Opus but above any single open model, because most
  // turns land on one of those two tiers. `provider sync` must not price-reconcile
  // this row (see syncProviderModels), since no published rate exists to match.
  { id: 'fireworks:accounts/fireworks/routers/firerouter', name: 'firerouter', displayName: 'FireRouter', providerModelId: 'accounts/fireworks/routers/firerouter', invocationModelId: 'accounts/fireworks/routers/firerouter', capabilities: ['planning', 'coding', 'review', 'repair'], speed: 7, quality: 8.75, contextLength: 1048576, reasoning: 'strong', toolUse: true, streaming: true, inputCostPerMTok: 0.8, cacheReadCostPerMTok: 0.15, outputCostPerMTok: 4, billingMode: 'api', pricingSource: 'FireRouter - varies by routed model (pooled estimate)', pricingUpdatedAt: '2026-10-05' },
  { id: 'fireworks:accounts/fireworks/models/kimi-k3', name: 'kimi-k3', displayName: 'Kimi K3', providerModelId: 'accounts/fireworks/models/kimi-k3', invocationModelId: 'accounts/fireworks/models/kimi-k3', capabilities: ['planning', 'coding', 'review', 'repair'], speed: 6, quality: 9, contextLength: 1048576, reasoning: 'frontier', toolUse: true, streaming: true, inputCostPerMTok: 3, cacheReadCostPerMTok: 0.3, outputCostPerMTok: 15, billingMode: 'api', pricingSource: 'Fireworks serverless pricing', pricingUpdatedAt: '2026-10-05' },
  { id: 'fireworks:accounts/fireworks/models/glm-5p3', name: 'glm-5p3', displayName: 'GLM 5.3', providerModelId: 'accounts/fireworks/models/glm-5p3', invocationModelId: 'accounts/fireworks/models/glm-5p3', capabilities: ['planning', 'coding', 'review', 'repair'], speed: 7, quality: 8.5, contextLength: 1048576, reasoning: 'strong', toolUse: true, streaming: true, inputCostPerMTok: 1.4, cacheReadCostPerMTok: 0.26, outputCostPerMTok: 4.4, billingMode: 'api', pricingSource: 'Fireworks serverless pricing', pricingUpdatedAt: '2026-10-05' },
  { id: 'fireworks:accounts/fireworks/models/qwen3p8-max', name: 'qwen3p8-max', displayName: 'Qwen 3.8 Max', providerModelId: 'accounts/fireworks/models/qwen3p8-max', invocationModelId: 'accounts/fireworks/models/qwen3p8-max', capabilities: ['planning', 'coding', 'review', 'repair'], speed: 7, quality: 8.5, contextLength: 262144, reasoning: 'strong', toolUse: true, streaming: true, inputCostPerMTok: 2, cacheReadCostPerMTok: 0.25, outputCostPerMTok: 6, billingMode: 'api', pricingSource: 'Fireworks serverless pricing', pricingUpdatedAt: '2026-10-05' },
  { id: 'fireworks:accounts/fireworks/models/minimax-m3', name: 'minimax-m3', displayName: 'MiniMax M3', providerModelId: 'accounts/fireworks/models/minimax-m3', invocationModelId: 'accounts/fireworks/models/minimax-m3', capabilities: ['coding', 'repair'], speed: 8, quality: 7.5, contextLength: 512000, reasoning: 'strong', toolUse: true, streaming: true, inputCostPerMTok: 0.3, cacheReadCostPerMTok: 0.06, outputCostPerMTok: 1.2, billingMode: 'api', pricingSource: 'Fireworks serverless pricing', pricingUpdatedAt: '2026-10-05' },
  { id: 'fireworks:accounts/fireworks/models/glm-5p3-flash', name: 'glm-5p3-flash', displayName: 'GLM 5.3 Flash', providerModelId: 'accounts/fireworks/models/glm-5p3-flash', invocationModelId: 'accounts/fireworks/models/glm-5p3-flash', capabilities: ['coding', 'repair'], speed: 9, quality: 7, contextLength: 1048576, reasoning: 'moderate', toolUse: true, streaming: true, inputCostPerMTok: 0.15, cacheReadCostPerMTok: 0.03, outputCostPerMTok: 0.5, billingMode: 'api', pricingSource: 'Fireworks serverless pricing', pricingUpdatedAt: '2026-10-05' },
  { id: 'fireworks:accounts/fireworks/models/gpt-oss-120b', name: 'gpt-oss-120b', displayName: 'GPT OSS 120B', providerModelId: 'accounts/fireworks/models/gpt-oss-120b', invocationModelId: 'accounts/fireworks/models/gpt-oss-120b', capabilities: ['coding'], speed: 9, quality: 6.5, contextLength: 131072, reasoning: 'moderate', toolUse: true, streaming: true, inputCostPerMTok: 0.15, cacheReadCostPerMTok: 0.015, outputCostPerMTok: 0.6, billingMode: 'api', pricingSource: 'Fireworks serverless pricing', pricingUpdatedAt: '2026-10-05' },
];

// Each built-in provider: its row, and the catalog its models are synced from.
export const BUILTIN_PROVIDERS = [
  { id: 'anthropic-claude-code', name: 'Anthropic (Claude login)', kind: 'claude-code', enabled: true, config: { billingMode: 'subscription' }, models: CLAUDE_MODELS },
  { id: 'deepseek-claude-code', name: 'DeepSeek', kind: 'deepseek', enabled: false, config: { apiKeyEnv: 'DEEPSEEK_API_KEY', billingMode: 'api' }, models: DEEPSEEK_MODELS },
  { id: 'openrouter', name: 'OpenRouter', kind: 'openrouter', enabled: false, config: { apiKeyEnv: 'OPENROUTER_API_KEY', billingMode: 'api' }, models: OPENROUTER_MODELS },
  { id: 'fireworks', name: 'Fireworks', kind: 'fireworks', enabled: false, config: { apiKeyEnv: 'FIREWORKS_API_KEY', billingMode: 'api' }, models: FIREWORKS_MODELS },
];

/**
 * What a turn cost from its token counts, at the model's published rates. Null when
 * the model has no price. The SDK reports its own estimate as total_cost_usd, but it
 * prices every model as if it were Anthropic's, which is wrong for a hosted one.
 * @param {import('./contract.mjs').Model | null} m
 * @param {{input_tokens?:number, output_tokens?:number, cache_read_input_tokens?:number, cache_creation_input_tokens?:number}} u
 */
export function priceUsage(m, u) {
  if (!m || m.input_cost_per_mtok == null) return null;
  const r = (/** @type {number|null|undefined} */ rate, /** @type {number|undefined} */ n) => ((rate ?? 0) * (n || 0)) / 1e6;
  return (
    r(m.input_cost_per_mtok, u.input_tokens) +
    r(m.output_cost_per_mtok, u.output_tokens) +
    r(m.cache_read_cost_per_mtok ?? m.input_cost_per_mtok, u.cache_read_input_tokens) +
    r(m.cache_write_cost_per_mtok ?? m.input_cost_per_mtok, u.cache_creation_input_tokens)
  );
}
