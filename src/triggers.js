/**
 * Trigger pre-checks: the cheap look before waking the model.
 *
 * A mail or calendar routine fires every N minutes, but most of those are
 * quiet. The check is one connector read and no model call; the agent only
 * runs when there is genuinely something new, and it is handed what was
 * found so it does not have to search again.
 */
import * as mail from './mail.js';
import * as calendar from './calendar.js';

/**
 * @returns {Promise<{fire: boolean, context: string, seen: string[]}>}
 */
export async function checkTrigger(userId, routine) {
  const seenBefore = new Set(routine.lastSeen ?? []);

  if (routine.kind === 'mail') {
    const results = await mail.search(userId, routine.query ?? '', 10);
    const fresh = results.filter((m) => !seenBefore.has(m.id));
    const seen = [...seenBefore, ...results.map((m) => m.id)];
    if (!fresh.length) return { fire: false, context: '', seen };
    const lines = fresh.map((m) => `- id ${m.id} | from ${m.from} | ${m.date} | ${m.subject}${m.snippet ? ` | ${m.snippet}` : ''}`);
    return {
      fire: true,
      seen,
      context: `TRIGGER: ${fresh.length} new email${fresh.length === 1 ? '' : 's'} matching "${routine.query || 'anything'}":\n${lines.join('\n')}\nUse read_email on an id for the full text.`,
    };
  }

  if (routine.kind === 'calendar') {
    const now = new Date();
    const to = new Date(now.getTime() + (routine.lead ?? 60) * 60_000);
    const events = await calendar.agenda(userId, { from: now.toISOString(), to: to.toISOString(), limit: 10 });
    const fresh = events.filter((e) => !seenBefore.has(e.id));
    const seen = [...seenBefore, ...events.map((e) => e.id)];
    if (!fresh.length) return { fire: false, context: '', seen };
    const lines = fresh.map((e) => `- id ${e.id} | ${e.start} to ${e.end ?? '?'} | ${e.title}${e.location ? ` @ ${e.location}` : ''}${e.attendees?.length ? ` | with ${e.attendees.join(', ')}` : ''}`);
    return {
      fire: true,
      seen,
      context: `TRIGGER: ${fresh.length} event${fresh.length === 1 ? '' : 's'} starting within ${routine.lead ?? 60} minutes:\n${lines.join('\n')}`,
    };
  }

  return { fire: true, context: '', seen: [] };
}
