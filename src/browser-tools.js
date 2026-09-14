/**
 * The agent's window onto the web.
 *
 * One tool deliberately: navigate and read. Clicking and form-filling are
 * possible over the same CDP connection, but every extra verb is another way
 * for the model to get lost, and "go to a page and tell me what it says"
 * covers the overwhelming majority of what a personal assistant is asked.
 *
 * Screenshots never enter the tool result - a base64 PNG in the model's
 * context is ruinously expensive. The frame is parked on the session and the
 * event stream picks it up for the UI.
 */
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';

export function makeBrowserTools({ browser }) {
  const browse = tool({
    name: 'browse',
    description:
      'Open a web page in your browser and read it. Use this for anything you need from the ' +
      'live web: checking a site, reading an article, looking up current information. ' +
      'Returns the page title and its visible text.',
    inputSchema: z.object({
      url: z.string().describe('The page to open, e.g. "example.com" or a full https URL.'),
    }),
    callback: async ({ url }) => {
      // goto() is serialised, so by the time it resolves this call owns the tab.
      const finalUrl = await browser.goto(url);
      const [title, text] = await Promise.all([browser.title(), browser.text()]);
      // No capture here: the event stream ticks frames on its own clock while
      // this call is still running, which is what makes the monitor update
      // live rather than all at once when the tool returns.
      return { url: finalUrl, title, text };
    },
  });

  return [browse];
}
