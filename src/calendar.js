/**
 * Calendar access for agents.
 *
 * The same door-with-two-rooms as `mail.js`: a real Google Calendar when the
 * connector has a provider configured, a stub schedule when it does not, so
 * the demo works with no Google account at all.
 */
import * as gcal from './gcal.js';
import { isMock as connectorIsMock } from './connectors.js';

export const isMock = () => connectorIsMock('calendar');

// ------------------------------------------------------------- the stub

/** Anchored to today so the demo schedule is always "this week". */
const at = (dayOffset, hour, minutes = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minutes, 0, 0);
  return d.toISOString();
};

const SEEDS = () => [
  { id: 'e1', title: 'Standup', start: at(0, 9, 30), end: at(0, 9, 45), allDay: false,
    location: '', attendees: ['team@northwind.example'] },
  { id: 'e2', title: 'Q3 deck review with Priya', start: at(0, 14), end: at(0, 15), allDay: false,
    location: 'Meet', attendees: ['priya@northwind.example'] },
  { id: 'e3', title: 'Intro call - Sam Okafor', start: at(1, 11), end: at(1, 11, 30), allDay: false,
    location: 'Zoom', attendees: ['sam@parallelworks.example'] },
  { id: 'e4', title: 'Nimbus kickoff', start: at(3, 10), end: at(3, 12), allDay: false,
    location: 'Room 2', attendees: ['updates@nimbus.example'] },
  { id: 'e5', title: 'Dentist', start: at(6, 14, 30), end: at(6, 15, 15), allDay: false,
    location: 'Clinic', attendees: [] },
];

/** Written by the stub, so a created event shows up in the next listing. */
const added = [];

const stub = {
  async profile() {
    return { address: 'you@example.com', timeZone: 'Europe/London', mock: true };
  },

  async agenda(userId, { from, to, limit = 10, query } = {}) {
    const start = from ? Date.parse(from) : Date.now();
    const end = to ? Date.parse(to) : start + 7 * 864e5;
    const q = String(query ?? '').toLowerCase().trim();
    return [...SEEDS(), ...added]
      .filter((e) => Date.parse(e.start) >= start && Date.parse(e.start) <= end)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
      .filter((e) => !q || `${e.title} ${e.location} ${e.attendees.join(' ')}`.toLowerCase().includes(q))
      .slice(0, limit);
  },

  async read(userId, id) {
    const ev = [...SEEDS(), ...added].find((e) => e.id === id);
    if (!ev) throw new Error(`No event with id "${id}". Use list_events first.`);
    return ev;
  },

  async freeSlots(userId, { from, to, minutes = 30 } = {}) {
    const start = from ? Date.parse(from) : Date.now();
    const end = to ? Date.parse(to) : start + 7 * 864e5;
    const busy = [...SEEDS(), ...added]
      .map((e) => [Date.parse(e.start), Date.parse(e.end)])
      .filter(([s]) => s >= start && s <= end)
      .sort((a, b) => a[0] - b[0]);

    const gaps = [];
    let cursor = start;
    for (const [bStart, bEnd] of [...busy, [end, end]]) {
      if (bStart - cursor >= minutes * 60000) {
        gaps.push({ start: new Date(cursor).toISOString(), end: new Date(bStart).toISOString() });
      }
      cursor = Math.max(cursor, bEnd);
    }
    return gaps.slice(0, 20);
  },

  async counts() {
    const endOfDay = Date.now() + 864e5;
    return { today: SEEDS().filter((e) => Date.parse(e.start) <= endOfDay).length };
  },

  async createEvent(userId, { title, start, end, attendees = [], location = '', notes, notify }) {
    added.push({
      id: `n${added.length + 1}`, title, start, end: end ?? start,
      allDay: /^\d{4}-\d{2}-\d{2}$/.test(String(start)),
      location, attendees, ...(notes ? { notes } : {}),
    });
    return { ...added[added.length - 1], notified: Boolean(notify && attendees.length) };
  },

  async updateEvent(userId, id, fields) {
    const all = [...SEEDS(), ...added];
    const ev = all.find((e) => e.id === id);
    if (!ev) throw new Error(`No event with id "${id}". Use list_events first.`);
    const { notify, ...rest } = fields;
    const merged = { ...ev, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) };
    const slot = added.findIndex((e) => e.id === id);
    if (slot >= 0) added[slot] = merged; else added.push(merged);
    return { ...merged, notified: Boolean(notify && merged.attendees?.length) };
  },
};

// ------------------------------------------------------------- the door

const backend = () => (isMock() ? stub : gcal);

export const profile = (userId) => backend().profile(userId);
export const agenda = (userId, opts) => backend().agenda(userId, opts);
export const read = (userId, id) => backend().read(userId, id);
export const freeSlots = (userId, opts) => backend().freeSlots(userId, opts);
export const counts = (userId) => backend().counts(userId);
export const createEvent = (userId, fields) => backend().createEvent(userId, fields);
export const updateEvent = (userId, id, fields) => backend().updateEvent(userId, id, fields);
