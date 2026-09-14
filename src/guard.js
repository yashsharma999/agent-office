/**
 * Deadlines for tools.
 *
 * A tool that hangs - a page that never finishes loading, a VM that stopped
 * answering - would otherwise hang the whole turn, and with it the browser
 * tab, the Telegram placeholder and the job. Every tool the team hands out
 * goes through here, so a stuck one comes back as an ordinary error the
 * model can see and route around.
 *
 * Agents used as tools (colleagues) are wrapped too, with a longer leash:
 * a delegated job is legitimately minutes of work.
 */
import { Tool, ToolResultBlock, TextBlock } from '@strands-agents/sdk';

const createErrorResult = (message, toolUseId) =>
  new ToolResultBlock({ toolUseId, status: 'error', content: [new TextBlock(String(message?.message ?? message))] });

const TIMEOUT = Symbol('timeout');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GuardedTool extends Tool {
  constructor(inner, ms) {
    super();
    this.inner = inner;
    this.ms = ms;
    this.name = inner.name;
    this.description = inner.description;
    this.toolSpec = inner.toolSpec;
  }

  async *stream(ctx) {
    const deadline = Date.now() + this.ms;
    const it = this.inner.stream(ctx);
    for (;;) {
      const left = deadline - Date.now();
      const step = left > 0
        ? await Promise.race([it.next(), sleep(left).then(() => TIMEOUT)])
        : TIMEOUT;
      if (step === TIMEOUT) {
        it.return?.().catch?.(() => {});
        return createErrorResult(
          `${this.name} took longer than ${Math.round(this.ms / 1000)}s and was stopped. `
          + 'Try a smaller step, or tell the user it did not finish.',
          ctx.toolUse.toolUseId,
        );
      }
      if (step.done) return step.value;
      yield step.value;
    }
  }
}

/** Seconds a plain tool may run. Browsing and shells are the slow ones. */
export const TOOL_TIMEOUT_MS = Number(process.env.TOOL_TIMEOUT_MS || 180_000);
/** Seconds a colleague may spend on one delegated job. */
export const HANDOFF_TIMEOUT_MS = Number(process.env.HANDOFF_TIMEOUT_MS || 900_000);

export const guardTools = (tools, ms = TOOL_TIMEOUT_MS) =>
  tools.map((t) => (t instanceof Tool ? new GuardedTool(t, ms) : t));
