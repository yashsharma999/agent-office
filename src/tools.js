/**
 * Tools the agent can call.
 *
 * Each tool is a plain function plus a Zod schema describing its input.
 * The schema is what the model sees, so name things clearly and write a
 * description that says WHEN to use the tool, not just what it does.
 */
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';

/** Files the agent is allowed to touch. Everything is confined to this root. */
const ROOT = process.cwd();

/** Blocks path traversal out of ROOT and reading obvious secrets. */
function safePath(input) {
  const full = resolve(ROOT, input);
  const rel = relative(ROOT, full);
  if (rel.startsWith('..') || resolve(rel) === rel) {
    throw new Error(`Path "${input}" is outside the project directory.`);
  }
  if (/(^|\/)\.env(\.|$)/.test(rel) || /(^|\/)\.git(\/|$)/.test(rel)) {
    throw new Error(`Path "${input}" is not readable for security reasons.`);
  }
  return full;
}

export const getCurrentTime = tool({
  name: 'get_current_time',
  description:
    'Get the current date and time. Use this whenever the user asks about "now", "today", or anything time-relative.',
  inputSchema: z.object({
    timeZone: z
      .string()
      .optional()
      .describe('IANA timezone such as "Asia/Kolkata" or "UTC". Defaults to the system timezone.'),
  }),
  callback: ({ timeZone }) => {
    const now = new Date();
    const zone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      return {
        iso: now.toISOString(),
        timeZone: zone,
        formatted: now.toLocaleString('en-US', { timeZone: zone, dateStyle: 'full', timeStyle: 'long' }),
      };
    } catch {
      throw new Error(`Unknown timezone "${zone}". Use an IANA name like "Asia/Kolkata".`);
    }
  },
});

export const calculate = tool({
  name: 'calculate',
  description:
    'Evaluate an arithmetic expression. Use this for any math instead of computing it yourself. Supports + - * / % ** and parentheses.',
  inputSchema: z.object({
    expression: z.string().describe('An arithmetic expression, e.g. "(1200 * 0.18) + 45"'),
  }),
  callback: ({ expression }) => {
    // Whitelist characters so this can never execute arbitrary code.
    if (!/^[0-9+\-*/%.()\s*]+$/.test(expression)) {
      throw new Error('Expression may only contain numbers, spaces and + - * / % ** ( ).');
    }
    let value;
    try {
      value = Function(`"use strict"; return (${expression});`)();
    } catch {
      throw new Error(`Could not parse "${expression}".`);
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`"${expression}" did not evaluate to a finite number.`);
    }
    return { expression, result: value };
  },
});

export const listFiles = tool({
  name: 'list_files',
  description:
    'List files and folders inside the project. Use this to discover what exists before reading a file.',
  inputSchema: z.object({
    directory: z.string().optional().describe('Project-relative folder. Defaults to the project root.'),
  }),
  callback: async ({ directory }) => {
    const dir = safePath(directory || '.');
    const entries = await readdir(dir, { withFileTypes: true });
    const visible = entries.filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules');
    return {
      directory: relative(ROOT, dir) || '.',
      entries: visible.map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' })),
    };
  },
});

export const readProjectFile = tool({
  name: 'read_file',
  description:
    'Read a text file from the project. Use list_files first if you are unsure of the exact path.',
  inputSchema: z.object({
    path: z.string().describe('Project-relative file path, e.g. "src/model.js"'),
    maxBytes: z.number().optional().describe('Truncate after this many bytes. Default 20000.'),
  }),
  callback: async ({ path, maxBytes }) => {
    const full = safePath(path);
    const info = await stat(full);
    if (!info.isFile()) throw new Error(`"${path}" is not a file.`);
    const limit = maxBytes ?? 20_000;
    const text = await readFile(full, 'utf8');
    return {
      path,
      bytes: info.size,
      truncated: text.length > limit,
      content: text.slice(0, limit),
    };
  },
});

/**
 * Everything the default agent gets.
 *
 * `listFiles` / `readProjectFile` are deliberately NOT here. Once the agent
 * has a sandbox it has a real filesystem, and offering a second set of file
 * tools pointed at this container's own source just makes the model guess
 * wrong about which disk it is on. They stay exported for local debugging.
 */
export const allTools = [getCurrentTime, calculate];
