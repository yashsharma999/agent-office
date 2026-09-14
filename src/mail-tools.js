/**
 * Gmail tools, handed only to agents the user has granted a pass.
 *
 * Deliberately no send. The agent prepares; the human sends. That keeps the
 * scariest action out of the model's hands and makes "here is the draft I
 * wrote you" the natural end of a turn.
 */
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import * as mail from './mail.js';
import { orAskToConnect } from './accounts.js';
import { approveFirst } from './approvals.js';

export function makeMailTools({ userId, unattended = false }) {
  const searchEmail = tool({
    name: 'search_email',
    description:
      'Search the user\'s inbox. Use it whenever they refer to an email, a sender, or ' +
      'something they were told. Returns matching messages with a snippet - call ' +
      'read_email for the full text.',
    inputSchema: z.object({
      query: z.string().optional().describe('Words to match on. Omit for the most recent mail.'),
      limit: z.number().optional().describe('How many to return. Default 5.'),
    }),
    callback: ({ query, limit }) => orAskToConnect(async () => {
      const results = await mail.search(userId, query ?? '', limit ?? 5);
      return results.length ? { count: results.length, results } : { count: 0, note: 'Nothing matched.' };
    }),
  });

  const readEmail = tool({
    name: 'read_email',
    description: 'Read one message in full, by the id returned from search_email.',
    inputSchema: z.object({ id: z.string().describe('Message id from search_email.') }),
    callback: ({ id }) => orAskToConnect(() => mail.read(userId, id)),
  });

  const draftEmail = tool({
    name: 'draft_email',
    description:
      'Save a draft to the user\'s mailbox for them to review and send. Use this ' +
      'whenever they ask you to write or reply to an email. You cannot send mail - ' +
      'say the draft is waiting for them.',
    inputSchema: z.object({
      to: z.string().describe('Recipient address.'),
      subject: z.string(),
      body: z.string().describe('The full email text.'),
    }),
    callback: (args, ctx) => {
      approveFirst(ctx, unattended, {
        tool: 'draft_email',
        summary: `Leave a draft to ${args.to}: "${args.subject}"`,
        input: args,
      });
      return orAskToConnect(() => mail.draft(userId, args));
    },
  });

  return [searchEmail, readEmail, draftEmail];
}
