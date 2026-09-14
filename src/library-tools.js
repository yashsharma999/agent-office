/**
 * Tools that connect the agent's desk (the sandbox) to its filing cabinet (S3).
 *
 * The agent never touches S3 directly. It asks to fetch a file onto the desk,
 * or to file one away, and these tools move the bytes. That keeps the mental
 * model the model has to hold down to one place where work happens.
 */
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import * as library from './library.js';
import { mimeFor } from './artifacts.js';

/**
 * @param {object} ctx
 * @param {string} ctx.userId     whose cabinet this is
 * @param {import('./agentcore-sandbox.js').AgentCoreSandbox} [ctx.workspace]
 */
export function makeLibraryTools({ userId, workspace }) {
  const listSaved = tool({
    name: 'list_saved_files',
    description:
      'List the files kept for this user between conversations. Use it whenever they refer to ' +
      'a document from earlier, ask what you have, or ask for something back.',
    inputSchema: z.object({}),
    callback: async () => {
      const files = await library.list(userId);
      return files.length
        ? { count: files.length, files }
        : { count: 0, files: [], note: 'Nothing saved yet.' };
    },
  });

  const openSaved = tool({
    name: 'open_saved_file',
    description:
      'Fetch a saved file onto your workspace so you can read or edit it, and so the user gets ' +
      'a download link for it. Use this to hand back a document they asked for.',
    inputSchema: z.object({
      name: z.string().describe('Exact filename from list_saved_files.'),
    }),
    callback: async ({ name }) => {
      if (!workspace) throw new Error('No workspace is available.');
      const bytes = await library.get(userId, name);
      await workspace.writeFile(name, bytes);
      return { name, bytes: bytes.length, note: `${name} is now in your working directory.` };
    },
  });

  const saveFile = tool({
    name: 'save_file',
    description:
      'File a document from your workspace so it survives after this conversation. ' +
      'Files the user gives you, and documents you produce, are saved automatically - ' +
      'use this only for something you created mid-task that would otherwise be lost.',
    inputSchema: z.object({
      name: z.string().describe('Filename in your working directory.'),
    }),
    callback: async ({ name }) => {
      if (!workspace) throw new Error('No workspace is available.');
      const bytes = await workspace.readFile(name);
      const saved = await library.put(userId, name, bytes, mimeFor(name));
      return { saved, bytes: bytes.length };
    },
  });

  const deleteSaved = tool({
    name: 'delete_saved_file',
    description: 'Permanently delete a saved file. Only do this when the user explicitly asks.',
    inputSchema: z.object({ name: z.string() }),
    callback: async ({ name }) => {
      await library.remove(userId, name);
      return { deleted: name };
    },
  });

  return [listSaved, openSaved, saveFile, deleteSaved];
}
