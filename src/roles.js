/**
 * Role templates.
 *
 * A template is a head start in the Foundry: a name, a way of working, the
 * computer that suits it, the passes it needs, and one or more skills. A
 * skill is a short markdown playbook in `skills/` that rides in the agent's
 * prompt, so a "researcher" built from the template already knows how to
 * research rather than being told to be one.
 *
 * Templates only pre-fill; the user can change anything afterwards. The id
 * is kept on the agent so the skills stay attached when the prompt is edited.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');

export const ROLES = {
  researcher: {
    id: 'researcher', label: 'Researcher', rig: 'desk', grants: [], skills: ['research'],
    blurb: 'Reads the live web, checks sources, comes back with what is true.',
    name: 'Scout',
    instructions:
      'You are a researcher. Find out what is actually the case, with sources. '
      + 'Prefer primary sources and recent ones. Say when the evidence is thin.',
  },
  writer: {
    id: 'writer', label: 'Writer', rig: 'desk', grants: [], skills: ['writing'],
    blurb: 'Drafts, edits and tightens prose. Makes documents.',
    name: 'Quill',
    instructions:
      'You are a writer and editor. Produce clean, specific prose in the voice asked for. '
      + 'Build documents (PDF, docx, slides) in your workspace when a file is wanted.',
  },
  scheduler: {
    id: 'scheduler', label: 'Scheduler', rig: 'desk', grants: ['gmail', 'calendar'], skills: ['inbox', 'calendar'],
    blurb: 'Runs the inbox and the diary. Drafts replies, finds times, books them.',
    name: 'Booker',
    instructions:
      'You are a personal scheduler. Keep the calendar sane and the inbox answered. '
      + 'Draft, never send. Book only what the user asked for, and confirm what you booked.',
  },
  analyst: {
    id: 'analyst', label: 'Analyst', rig: 'desk', grants: [], skills: ['data'],
    blurb: 'Numbers, spreadsheets, charts. Shows the working.',
    name: 'Ledger',
    instructions:
      'You are a data analyst. Work in Python in your workspace: load, check, compute, chart. '
      + 'State assumptions, show the figures, and hand back files.',
  },
  operator: {
    id: 'operator', label: 'Operator', rig: 'rig', grants: [], skills: ['web', 'research'],
    blurb: 'Gets things done on websites: forms, lookups, multi-step tasks.',
    name: 'Ranger',
    instructions:
      'You are an operator. Use the browser to complete tasks on real websites step by step. '
      + 'Never enter passwords or payment details; stop and report when a site asks for them.',
  },
};

export const isRole = (id) => Boolean(ROLES[id]);

const cache = new Map();
/** The playbook text for a skill id, or '' when there is no such file. */
export function skillText(id) {
  if (cache.has(id)) return cache.get(id);
  const file = join(SKILLS_DIR, `${String(id).replace(/[^a-z0-9_-]/g, '')}.md`);
  const text = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  cache.set(id, text);
  return text;
}

/** Everything the prompt should carry for a template: its skills, joined. */
export function skillsFor(roleId) {
  const role = ROLES[roleId];
  if (!role) return '';
  return role.skills.map(skillText).filter(Boolean).join('\n\n');
}

/** What the Foundry shows. */
export const roleCatalogue = () =>
  Object.values(ROLES).map(({ id, label, blurb, rig, grants, skills, name, instructions }) => ({
    id, label, blurb, rig, grants, skills, name, instructions,
  }));
