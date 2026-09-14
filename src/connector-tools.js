/**
 * Which tools each connector hands out.
 *
 * Keyed by connector id so `team.js` needs no special cases: holding a pass is
 * the whole condition for getting the tools.
 */
import { makeMailTools } from './mail-tools.js';
import { makeCalendarTools } from './calendar-tools.js';

export const TOOLS_FOR = {
  gmail: makeMailTools,
  calendar: makeCalendarTools,
};
