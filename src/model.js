/**
 * Single place to pick which LLM the agents use.
 *
 * Switch models by editing .env, no code changes:
 *   MODEL_PROVIDER=bedrock    -> AWS Bedrock (uses your AWS credits)
 *   MODEL_PROVIDER=anthropic  -> Anthropic API directly (uses ANTHROPIC_API_KEY)
 *   MODEL_PROVIDER=ollama     -> Ollama on your machine (free)
 *
 * Optional per-provider overrides:
 *   BEDROCK_MODEL_ID, BEDROCK_REGION, ANTHROPIC_MODEL_ID, OLLAMA_MODEL_ID, OLLAMA_HOST
 *
 * Or pick a preset by name from PRESETS below:
 *   MODEL_PRESET=local | dev | demo
 *
 * Note: the Strands TS SDK has no dedicated Ollama provider (Python only).
 * Ollama exposes an OpenAI-compatible API, so we point OpenAIModel at it.
 */
import { BedrockModel } from '@strands-agents/sdk/models/bedrock';
import { AnthropicModel } from '@strands-agents/sdk/models/anthropic';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';

export const PRESETS = {
  // Ollama. Free, no AWS/Anthropic billing. Needs the Ollama app running.
  // NOTE: ':cloud' ids run on Ollama's cloud, not your machine (needs `ollama signin`).
  // glm-5.3 is 753B params, so it could never run locally anyway.
  // For a genuinely offline model: `ollama pull llama3.1`, then set
  // OLLAMA_MODEL_ID=llama3.1 in .env.
  local: {
    provider: 'ollama',
    modelId: 'glm-5.3:cloud',
  },
  // Day-to-day building: cheap, fast, paid for by AWS credits.
  dev: {
    provider: 'bedrock',
    modelId: 'global.anthropic.claude-sonnet-4-6',
  },
  // Demo time: strongest model, billed to your Anthropic API key.
  demo: {
    provider: 'anthropic',
    modelId: 'claude-opus-5',
  },
};

const DEFAULTS = {
  bedrock: {
    modelId: 'global.anthropic.claude-sonnet-4-6',
    region: 'us-east-1',
  },
  anthropic: {
    modelId: 'claude-sonnet-4-6',
  },
  ollama: {
    modelId: 'llama3.1',
    host: 'http://localhost:11434',
  },
};

/**
 * Build a model instance.
 *
 * @param {object} [overrides]
 * @param {'bedrock'|'anthropic'|'ollama'} [overrides.provider]
 * @param {string} [overrides.modelId]
 * @param {string} [overrides.preset]  name from PRESETS
 * @param {number} [overrides.maxTokens]
 * @param {boolean} [overrides.reasoning]  stream the model's thinking, where supported
 */
export function createModel(overrides = {}) {
  const preset = PRESETS[overrides.preset ?? process.env.MODEL_PRESET] ?? {};

  const provider =
    overrides.provider ?? preset.provider ?? process.env.MODEL_PROVIDER ?? 'bedrock';

  const maxTokens = overrides.maxTokens ?? Number(process.env.MAX_TOKENS ?? 4096);
  const reasoning = overrides.reasoning ?? process.env.REASONING === 'true';
  // Budget has to leave room for the answer itself.
  const thinkingBudget = Math.min(2048, Math.floor(maxTokens / 2));

  if (provider === 'anthropic') {
    const modelId =
      overrides.modelId ?? process.env.ANTHROPIC_MODEL_ID ?? preset.modelId ?? DEFAULTS.anthropic.modelId;
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('MODEL_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set in .env');
    }
    return new AnthropicModel({
      modelId,
      maxTokens,
      ...(reasoning ? { params: { thinking: { type: 'enabled', budget_tokens: thinkingBudget } } } : {}),
    });
  }

  if (provider === 'ollama') {
    const modelId =
      overrides.modelId ?? process.env.OLLAMA_MODEL_ID ?? preset.modelId ?? DEFAULTS.ollama.modelId;
    const host = process.env.OLLAMA_HOST ?? DEFAULTS.ollama.host;
    return new OpenAIModel({
      // Ollama implements Chat Completions, not the newer Responses API.
      api: 'chat',
      modelId,
      maxTokens,
      // Ollama ignores the key, but the OpenAI client requires a non-empty value.
      apiKey: process.env.OLLAMA_API_KEY ?? 'ollama',
      clientConfig: {
        baseURL: `${host.replace(/\/$/, '')}/v1`,
      },
    });
  }

  if (provider === 'bedrock') {
    const modelId =
      overrides.modelId ?? process.env.BEDROCK_MODEL_ID ?? preset.modelId ?? DEFAULTS.bedrock.modelId;
    const region = process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? DEFAULTS.bedrock.region;
    return new BedrockModel({
      modelId,
      region,
      maxTokens,
      ...(reasoning
        ? { additionalRequestFields: { thinking: { type: 'enabled', budget_tokens: thinkingBudget } } }
        : {}),
    });
  }

  throw new Error(
    `Unknown MODEL_PROVIDER "${provider}". Use "bedrock", "anthropic" or "ollama".`,
  );
}

/** Human-readable label for logs. */
export function describeModel(model) {
  const cfg = model.getConfig();
  const provider =
    model instanceof AnthropicModel ? 'anthropic'
    : model instanceof OpenAIModel ? 'ollama'
    : 'bedrock';
  return `${provider}:${cfg.modelId}`;
}
