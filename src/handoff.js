/**
 * Handoff envelopes.
 *
 * The SDK's agent-as-tool gives a colleague one string and nothing else, so
 * every delegated job started with an empty head: no idea who the user is,
 * what the boss already found out, or what shape the answer should take.
 *
 * This is the same adapter with a form instead of a string. The boss fills
 * in a brief, the context it already has, the deliverable and any
 * constraints; the envelope adds who the user is, the date and the house
 * rules, and the colleague starts the job knowing what a good colleague would.
 *
 * Inner events still stream out, tagged with who produced them, so the room
 * can animate several colleagues working at once.
 */
import { Tool, ToolStreamEvent, ToolResultBlock, TextBlock } from '@strands-agents/sdk';

const createErrorResult = (message, toolUseId) =>
  new ToolResultBlock({ toolUseId, status: 'error', content: [new TextBlock(String(message?.message ?? message))] });

const HOUSE_RULES = [
  'Never send email; you may leave a draft and say it is waiting.',
  'Change the calendar only when the brief asks for it, and never email attendees unless told to.',
  'If something cannot be done, say exactly what you could not do rather than working around it.',
  'Return the finished work itself - the text, the numbers, the filename - not a description of it.',
];

export class HandoffTool extends Tool {
  /**
   * @param {object} o
   * @param {import('@strands-agents/sdk').Agent} o.agent  the colleague
   * @param {string} o.name        tool name (the colleague's tool name)
   * @param {string} o.description what this colleague is for
   * @param {() => object} o.about  facts about the user and the boss, read per call
   */
  constructor({ agent, name, description, about }) {
    super();
    this.agent = agent;
    this.name = name;
    this.description =
      `${description} Hand over a complete brief: what to do, what you already know, and what to come back with.`;
    this.about = about ?? (() => ({}));
    this.initial = agent.takeSnapshot({ preset: 'session' });
    this.busy = false;
    this.toolSpec = {
      name,
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: {
          brief: { type: 'string', description: 'The job, in full. What to do and why.' },
          context: { type: 'string', description: 'What you already know that they need: facts found, the user\'s words, decisions made.' },
          deliverable: { type: 'string', description: 'Exactly what to come back with, and in what form (a list, a draft, a file, a yes/no).' },
          constraints: { type: 'string', description: 'Limits: time window, sources to avoid, tone, length.' },
        },
        required: ['brief'],
      },
    };
  }

  envelope({ brief, context, deliverable, constraints }) {
    const a = this.about();
    const lines = [
      `HANDOFF from ${a.from ?? 'your colleague'}`,
      '',
      `BRIEF\n${brief}`,
    ];
    if (context) lines.push('', `WHAT IS ALREADY KNOWN\n${context}`);
    lines.push('', `DELIVERABLE\n${deliverable || 'The finished work, ready to relay to the user as is.'}`);
    if (constraints) lines.push('', `CONSTRAINTS\n${constraints}`);
    const who = [a.user && `user: ${a.user}`, a.date && `date: ${a.date}`, a.timeZone && `time zone: ${a.timeZone}`]
      .filter(Boolean).join(' | ');
    if (who) lines.push('', `ABOUT THE USER\n${who}`);
    if (a.notes) lines.push('', `NOTES FROM ${String(a.from ?? 'the boss').toUpperCase()}\n${a.notes}`);
    lines.push('', 'HOUSE RULES\n' + HOUSE_RULES.map((r) => `- ${r}`).join('\n'));
    return lines.join('\n');
  }

  async *stream(ctx) {
    const { toolUse, invocationState, cancelSignal } = ctx;
    const toolUseId = toolUse.toolUseId;
    if (this.busy) return createErrorResult(`${this.name} is already on a job; wait for it to finish.`, toolUseId);
    this.busy = true;
    try {
      // Every job starts from the same clean state.
      this.agent.loadSnapshot(this.initial);
      const gen = this.agent.stream(this.envelope(toolUse.input ?? {}), { invocationState, cancelSignal });
      let next = await gen.next();
      while (!next.done) {
        const ev = next.value;
        // Tagged with who is speaking, so parallel colleagues stay apart.
        yield new ToolStreamEvent({ data: { who: this.name, event: ev.type === 'toolStreamUpdateEvent' ? ev.event?.data : ev } });
        next = await gen.next();
      }
      const result = next.value;
      if (result.stopReason === 'cancelled') return createErrorResult(`${this.name} was cancelled`, toolUseId);
      if (result.stopReason === 'interrupt') {
        // A colleague asked for approval mid-job. Surface it as a plain
        // result: the boss must stop and ask rather than pretend it is done.
        const asks = (result.interrupts ?? []).map((i) => i.reason?.summary ?? i.name).join('; ');
        return new ToolResultBlock({
          toolUseId, status: 'error',
          content: [new TextBlock(`${this.name} needs the user's approval before continuing: ${asks}. Do it yourself only if you have the tool and the user's go-ahead.`)],
        });
      }
      return new ToolResultBlock({ toolUseId, status: 'success', content: [new TextBlock(result.toString())] });
    } catch (err) {
      return createErrorResult(err, toolUseId);
    } finally {
      this.busy = false;
    }
  }
}
