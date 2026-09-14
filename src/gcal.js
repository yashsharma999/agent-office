/**
 * The Google Calendar API. Like `gmail.js`, this is only the shape of Google's
 * endpoints - `accounts.js` supplies the token.
 *
 * Read-only by deliberate choice, matching the connector's scope. An agent
 * that can quietly move a meeting is a different product decision, and one
 * worth making on purpose rather than by adding a scope.
 */
import { authedFetch } from './accounts.js';

const API = 'https://www.googleapis.com/calendar/v3';

const call = (userId, path, init) => authedFetch(userId, 'calendar', `${API}${path}`, init);

/** A calendar event's time is a timestamp, or a date when it lasts all day. */
const when = (slot) => slot?.dateTime ?? slot?.date ?? '';
const isAllDay = (ev) => Boolean(ev.start?.date && !ev.start?.dateTime);

function tidy(ev) {
  return {
    id: ev.id,
    title: ev.summary ?? '(no title)',
    start: when(ev.start),
    end: when(ev.end),
    allDay: isAllDay(ev),
    location: ev.location ?? '',
    attendees: (ev.attendees ?? []).map((a) => a.email).slice(0, 20),
    ...(ev.description ? { notes: String(ev.description).slice(0, 1000) } : {}),
  };
}

export async function profile(userId) {
  const cal = await call(userId, '/calendars/primary');
  return { address: cal.id, timeZone: cal.timeZone, mock: false };
}

/**
 * Events in a window, soonest first.
 * @param {string} [from] ISO instant. Defaults to now.
 * @param {string} [to] ISO instant. Defaults to seven days out.
 */
export async function agenda(userId, { from, to, limit = 10, query } = {}) {
  const start = from ? new Date(from) : new Date();
  const end = to ? new Date(to) : new Date(start.getTime() + 7 * 864e5);
  const params = new URLSearchParams({
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    maxResults: String(Math.min(limit, 50)),
    // Expands recurring events into real occurrences, which is what anyone
    // asking "what's on Tuesday" means.
    singleEvents: 'true',
    orderBy: 'startTime',
  });
  if (query) params.set('q', query);
  const out = await call(userId, `/calendars/primary/events?${params}`);
  return (out.items ?? []).map(tidy);
}

export async function read(userId, id) {
  return tidy(await call(userId, `/calendars/primary/events/${encodeURIComponent(id)}`));
}

/**
 * Gaps between events, for "when am I free".
 *
 * Uses the freebusy endpoint rather than reasoning over the agenda, so
 * declined events and other calendars are Google's problem, not ours.
 */
export async function freeSlots(userId, { from, to, minutes = 30 } = {}) {
  const start = from ? new Date(from) : new Date();
  const end = to ? new Date(to) : new Date(start.getTime() + 7 * 864e5);
  const out = await call(userId, '/freeBusy', {
    method: 'POST',
    body: JSON.stringify({
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      items: [{ id: 'primary' }],
    }),
  });

  const busy = (out.calendars?.primary?.busy ?? [])
    .map((b) => [new Date(b.start).getTime(), new Date(b.end).getTime()])
    .sort((a, b) => a[0] - b[0]);

  const gaps = [];
  let cursor = start.getTime();
  for (const [bStart, bEnd] of [...busy, [end.getTime(), end.getTime()]]) {
    if (bStart - cursor >= minutes * 60000) {
      gaps.push({ start: new Date(cursor).toISOString(), end: new Date(bStart).toISOString() });
    }
    cursor = Math.max(cursor, bEnd);
  }
  return gaps.slice(0, 20);
}

/** Only used by the room, to decide whether the desk calendar has anything on it. */
export async function counts(userId) {
  try {
    return { today: (await agenda(userId, { to: new Date(Date.now() + 864e5).toISOString(), limit: 50 })).length };
  } catch {
    return { today: 0 };
  }
}

/**
 * Adds an event.
 *
 * `notify` is off by default and that is deliberate: putting attendees on an
 * event makes Google email every one of them an invitation. An agent should
 * not be able to message the user's colleagues as a side effect of tidying a
 * diary, so sending has to be asked for.
 */
export async function createEvent(userId, { title, start, end, attendees, location, notes, notify = false }) {
  const created = await call(
    userId,
    `/calendars/primary/events?sendUpdates=${notify ? 'all' : 'none'}`,
    { method: 'POST', body: JSON.stringify(bodyFor({ title, start, end, attendees, location, notes })) },
  );
  return { ...tidy(created), notified: Boolean(notify && attendees?.length) };
}

/** Changes an existing event. Only the fields given are touched. */
export async function updateEvent(userId, id, { title, start, end, attendees, location, notes, notify = false }) {
  const patch = bodyFor({ title, start, end, attendees, location, notes }, { partial: true });
  const updated = await call(
    userId,
    `/calendars/primary/events/${encodeURIComponent(id)}?sendUpdates=${notify ? 'all' : 'none'}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
  );
  return { ...tidy(updated), notified: Boolean(notify && attendees?.length) };
}

/**
 * Google's event shape. A date with no time means all-day, which lives in a
 * different field to a timestamp.
 */
function bodyFor({ title, start, end, attendees, location, notes }, { partial = false } = {}) {
  const slot = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? { date: v } : { dateTime: new Date(v).toISOString() });
  const body = {};
  if (title !== undefined) body.summary = title;
  if (start !== undefined) body.start = slot(start);
  if (end !== undefined) body.end = slot(end);
  if (location !== undefined) body.location = location;
  if (notes !== undefined) body.description = notes;
  if (attendees !== undefined) body.attendees = (attendees ?? []).map((email) => ({ email }));
  if (!partial && !body.end) body.end = body.start;
  return body;
}
