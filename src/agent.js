/**
 * The project's agent definition. Import `createAgent()` anywhere you need one.
 */
import { Agent } from '@strands-agents/sdk';
import { createModel } from './model.js';
import { allTools } from './tools.js';

export const SYSTEM_PROMPT = `You are a helpful assistant with access to tools.

Rules:
- Use a tool whenever it can give you a fact. Never guess at the time or at arithmetic.
- If a tool errors, read the error and either fix your input or tell the user plainly.
- Keep answers short. Give the answer first, then a sentence of context if it helps.`;

/**
 * @param {object} [options]
 * @param {string} [options.preset]     'local' | 'dev' | 'demo'
 * @param {string} [options.provider]   overrides the preset
 * @param {string} [options.modelId]    overrides the preset
 * @param {Array}  [options.tools]      defaults to every tool in tools.js
 * @param {string} [options.systemPrompt]
 * @param {boolean} [options.printer]  false silences the SDK's stdout output,
 *                                     which you want when a UI renders the stream
 */
export function createAgent(options = {}) {
  const {
    preset,
    provider,
    modelId,
    tools = allTools,
    systemPrompt = SYSTEM_PROMPT,
    printer = true,
  } = options;
  return new Agent({
    model: createModel({ preset, provider, modelId }),
    systemPrompt,
    tools,
    printer,
  });
}
