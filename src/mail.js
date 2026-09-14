/**
 * Mail access for agents.
 *
 * One door, two rooms behind it. If `GMAIL_PROVIDER_NAME` is set we talk to
 * the real Gmail API with a token from the AgentCore Identity vault; if not we
 * serve a stub inbox, so the whole connector mechanism - passes, grants,
 * tools, the tray on the desk - works with no Google account at all.
 *
 * Everything above this file calls the same four functions either way.
 */
import * as gmail from './gmail.js';
import { isMock as connectorIsMock } from './connectors.js';

/** Live once a provider is configured. Surfaced to the UI so it can say so. */
export const isMock = () => connectorIsMock('gmail');

// ------------------------------------------------------------- the stub

const SEEDS = [
  {
    from: 'Priya Raman <priya@northwind.example>',
    subject: 'Q3 deck - can you review by Friday?',
    date: '2026-09-11',
    body: 'Hi,\n\nI have pushed the latest Q3 deck to the shared drive. Could you look '
      + 'over the revenue slides before Friday? Particularly slide 7, the churn numbers '
      + 'look off to me.\n\nThanks,\nPriya',
  },
  {
    from: 'AWS Billing <no-reply@amazon.example>',
    subject: 'Your September estimate is available',
    date: '2026-09-10',
    body: 'Your month-to-date estimate is $12.40. The largest contributor is Amazon '
      + 'Bedrock. View the full breakdown in the console.',
  },
  {
    from: 'Sam Okafor <sam@parallelworks.example>',
    subject: 'Intro call next week?',
    date: '2026-09-09',
    body: 'Great meeting you at the meetup. Would you be free for 30 minutes next week '
      + 'to talk through what you are building? Tuesday or Thursday both work my end.',
  },
  {
    from: 'Nimbus Project <updates@nimbus.example>',
    subject: 'Kickoff moved to 5 October',
    date: '2026-09-08',
    body: 'Heads up - the Nimbus kickoff has shifted from 28 September to 5 October. '
      + 'Budget is confirmed at 12,500 GBP. Agenda to follow.',
  },
  {
    from: 'Dr. Aisha Bello <a.bello@clinic.example>',
    subject: 'Appointment confirmation',
    date: '2026-09-07',
    body: 'This confirms your appointment on 19 September at 14:30. Please arrive ten '
      + 'minutes early.',
  },
];

/** Per-user mailbox. Seeded lazily so every user gets the same starting inbox. */
const boxes = new Map();

function boxFor(userId) {
  const key = String(userId || 'anon');
  if (!boxes.has(key)) {
    boxes.set(key, {
      messages: SEEDS.map((m, i) => ({ id: `m${i + 1}`, ...m })),
      drafts: [],
    });
  }
  return boxes.get(key);
}

const stub = {
  async profile() {
    return { address: 'you@example.com', mock: true };
  },

  async search(userId, query, limit) {
    const { messages } = boxFor(userId);
    // Models write Gmail operators ("from:priya", quoted phrases) out of
    // habit; the stub matches like Gmail would rather than string-equal.
    const terms = String(query).toLowerCase()
      .replace(/\b(from|to|subject|in|is|has|newer_than|older_than|after|before):/g, ' ')
      .replace(/["()]/g, ' ')
      .split(/\s+/).filter((t) => t && t !== 'or' && t !== 'and');
    const hits = terms.length
      ? messages.filter((m) => {
          const hay = `${m.from} ${m.subject} ${m.body}`.toLowerCase();
          return terms.every((t) => hay.includes(t));
        })
      : messages;
    return hits.slice(0, Math.max(1, Math.min(limit, 20))).map((m) => ({
      id: m.id,
      from: m.from,
      subject: m.subject,
      date: m.date,
      snippet: m.body.replace(/\s+/g, ' ').slice(0, 120),
    }));
  },

  async read(userId, id) {
    const msg = boxFor(userId).messages.find((m) => m.id === id);
    if (!msg) throw new Error(`No message with id "${id}". Use search_email first.`);
    return msg;
  },

  async draft(userId, { to, subject, body }) {
    const box = boxFor(userId);
    const entry = {
      id: `d${box.drafts.length + 1}`,
      to, subject, body,
      createdAt: new Date().toISOString(),
    };
    box.drafts.push(entry);
    return {
      draftId: entry.id,
      to, subject,
      words: String(body).trim().split(/\s+/).filter(Boolean).length,
      note: 'Saved to the demo mailbox. Once Gmail is connected this appears in your real Drafts.',
    };
  },

  async counts(userId) {
    const box = boxFor(userId);
    return { messages: box.messages.length, drafts: box.drafts.length };
  },
};

// ------------------------------------------------------------- the door

const backend = () => (isMock() ? stub : gmail);

/** Whose mailbox this is. */
export const profile = (userId) => backend().profile(userId);

/**
 * @returns {Promise<Array<{id, from, subject, date, snippet}>>}
 */
export const search = (userId, query = '', limit = 5) => backend().search(userId, query, limit);

export const read = (userId, id) => backend().read(userId, id);

/** Creates a draft. Deliberately never sends - the human does that. */
export const draft = (userId, fields) => backend().draft(userId, fields);

/** Only used by the room, to decide whether the inbox tray has anything in it. */
export const counts = (userId) => backend().counts(userId);
