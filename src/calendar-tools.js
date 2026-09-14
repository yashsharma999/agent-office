/**
 * Calendar tools, handed only to agents the user has granted a pass.
 *
 * The agent can read the week, find the gaps, and put things in the diary.
 *
 * What it cannot do without being told to is notify anyone: adding attendees
 * makes Google email each of them an invitation, so `notify` is off unless the
 * user asks for it. Deleting events is deliberately absent - cancelling a
 * meeting mails everyone and is not something to discover after the fact.
 */
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import * as calendar from './calendar.js';
import { orAskToConnect } from './accounts.js';
import { approveFirst } from './approvals.js';

export function makeCalendarTools({ userId, unattended = false }) {
  const listEvents = tool({
    name: 'list_events',
    description:
      "Look at the user's calendar. Use it whenever they mention their schedule, a "
      + 'meeting, or being busy. Times are ISO instants; today is whatever the current '
      + 'date is, so work out the range yourself rather than asking.',
    inputSchema: z.object({
      from: z.string().optional().describe('ISO start of the window. Defaults to now.'),
      to: z.string().optional().describe('ISO end of the window. Defaults to seven days out.'),
      query: z.string().optional().describe('Match on title, location or attendee.'),
      limit: z.number().optional().describe('How many to return. Default 10.'),
    }),
    callback: (args) => orAskToConnect(async () => {
      const events = await calendar.agenda(userId, args);
      return events.length
        ? { count: events.length, events }
        : { count: 0, note: 'Nothing scheduled in that window.' };
    }),
  });

  const readEvent = tool({
    name: 'read_event',
    description: 'Full detail for one event, by the id returned from list_events.',
    inputSchema: z.object({ id: z.string().describe('Event id from list_events.') }),
    callback: ({ id }) => orAskToConnect(() => calendar.read(userId, id)),
  });

  const findFreeTime = tool({
    name: 'find_free_time',
    description:
      'Gaps in the calendar long enough for a meeting. Use it when the user asks when '
      + 'they are free, or to suggest times to someone.',
    inputSchema: z.object({
      from: z.string().optional().describe('ISO start of the search. Defaults to now.'),
      to: z.string().optional().describe('ISO end of the search. Defaults to seven days out.'),
      minutes: z.number().optional().describe('Shortest useful gap. Default 30.'),
    }),
    callback: (args) => orAskToConnect(async () => {
      const slots = await calendar.freeSlots(userId, args);
      return slots.length
        ? { count: slots.length, slots }
        : { count: 0, note: 'No gaps that long in that window.' };
    }),
  });

  const createEvent = tool({
    name: 'create_event',
    description:
      "Put something in the user's calendar. Check find_free_time first unless they "
      + 'named a time. Attendees are NOT told about the event unless notify is true - '
      + 'ask before setting it, and say afterwards whether anyone was emailed.',
    inputSchema: z.object({
      title: z.string().describe('What the event is called.'),
      start: z.string().describe('ISO instant, or YYYY-MM-DD for an all-day event.'),
      end: z.string().optional().describe('ISO instant. Defaults to the same as start.'),
      attendees: z.array(z.string()).optional().describe('Email addresses to invite.'),
      location: z.string().optional(),
      notes: z.string().optional().describe('Description shown on the event.'),
      notify: z.boolean().optional()
        .describe('Email the attendees an invitation. Only when the user asked for it.'),
    }),
    callback: (args, ctx) => {
      approveFirst(ctx, unattended, {
        tool: 'create_event',
        summary: `Add "${args.title}" to the calendar at ${args.start}${args.attendees?.length ? ` with ${args.attendees.join(', ')}` : ''}${args.notify ? ' and email the attendees' : ''}`,
        input: args,
      });
      return orAskToConnect(() => calendar.createEvent(userId, args));
    },
  });

  const updateEvent = tool({
    name: 'update_event',
    description:
      'Change an event that already exists, by the id from list_events. Only the '
      + 'fields you pass are altered. The same notify rule applies as create_event.',
    inputSchema: z.object({
      id: z.string().describe('Event id from list_events.'),
      title: z.string().optional(),
      start: z.string().optional().describe('ISO instant, or YYYY-MM-DD for all-day.'),
      end: z.string().optional(),
      attendees: z.array(z.string()).optional().describe('Replaces the whole guest list.'),
      location: z.string().optional(),
      notes: z.string().optional(),
      notify: z.boolean().optional().describe('Email attendees about the change.'),
    }),
    callback: ({ id, ...fields }, ctx) => {
      approveFirst(ctx, unattended, {
        tool: 'update_event',
        summary: `Change event ${id}: ${Object.keys(fields).filter((k) => k !== 'notify').join(', ')}${fields.notify ? ', and email the attendees' : ''}`,
        input: { id, ...fields },
      });
      return orAskToConnect(() => calendar.updateEvent(userId, id, fields));
    },
  });

  return [listEvents, readEvent, findFreeTime, createEvent, updateEvent];
}
