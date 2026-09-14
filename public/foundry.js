import { connectAccount } from './connect.js';
import { CATALOG, lookFor, drawDoll } from './doll.js';

/**
 * The Foundry: where the user builds agents and buys them computers.
 *
 * The catalogue of rigs is fetched rather than duplicated here - `src/rigs.js`
 * on the server is the single source of truth for what each computer costs
 * and unlocks, so the shop can never drift from what the agents actually get.
 */

import { createPreview } from './preview.js';

const $ = (id) => document.getElementById(id);

/** How each rig scores, purely for the bars in the preview panel. */
const STATS = {
  tin:  { brain: 1, think: 0, kit: 0, cost: 1 },
  desk: { brain: 3, think: 2, kit: 3, cost: 3 },
  rig:  { brain: 5, think: 5, kit: 4, cost: 5 },
};

function bar(label, value, max = 5, cls = '') {
  const pips = Array.from({ length: max }, (_, i) =>
    `<i class="${i < value ? 'on' : ''}"></i>`).join('');
  return `<div class="stat ${cls}"><span>${label}</span><span class="bar2">${pips}</span></div>`;
}

export function createFoundry({ userId, onSaved, onConnections }) {
  const el = {
    panel: $('foundry'),
    rosterView: $('rosterView'),
    editorView: $('editorView'),
    list: $('rosterList'),
    rosterErr: $('rosterErr'),
    editErr: $('editErr'),
    name: $('agName'),
    instr: $('agInstr'),
    rigGrid: $('rigGrid'),
    skinRow: $('skinRow'),
    lookGrid: $('lookGrid'),
    tabs: $('editTabs'),
    tabAgent: $('tabAgent'),
    template: $('agTemplate'),
    tplHint: $('tplHint'),
    tabLook: $('tabLook'),
    lookStage: $('lookStage'),
    lookName: $('lookName'),
    lookTurn: $('lookTurn'),
    newBtn: $('newAgent'),
    saveBtn: $('saveAgent'),
    deleteBtn: $('deleteAgent'),
  };

  const preview = createPreview($('previewCanvas'));
  let catalogue = { rigs: [], skins: [], maxAgents: 2 };
  /** Role templates from the server: a head start, never a constraint. */
  let roles = [];
  let connectors = [];
  /** World-level: which accounts are linked at all. */
  let connections = {};
  let roster = [];
  /** Index being edited, or -1 for a new agent. */
  let editing = -1;
  let draft = null;

  // ------------------------------------------------------------ rendering
  const perk = (on, label) => (on ? `<b>+ ${label}</b>` : `<i>- ${label}</i>`);

  /** Pushes the current draft into the preview and its readout. */
  function syncPreview() {
    if (!draft) return;
    preview.set({ colour: draft.colour, rig: draft.rig, name: draft.name, look: draft.look });
    const rig = catalogue.rigs.find((r) => r.id === draft.rig);
    const stats = STATS[draft.rig] ?? STATS.desk;
    $('pvName').textContent = draft.name?.trim() || 'Unnamed';
    el.lookName.textContent = draft.name?.trim() || 'Unnamed';
    $('pvRig').textContent = rig?.label ?? draft.rig;
    $('pvCost').textContent = rig ? `${rig.modelLabel} · runs ${rig.costHint}` : '';
    $('pvStats').innerHTML =
      bar('BRAIN', stats.brain) +
      bar('THINKING', stats.think) +
      bar('HARDWARE', stats.kit) +
      bar('BURN RATE', stats.cost, 5, 'cost');
  }

  function renderRigs() {
    el.rigGrid.textContent = '';
    for (const rig of catalogue.rigs) {
      const card = document.createElement('div');
      card.className = 'rig-card' + (draft.rig === rig.id ? ' on' : '');
      card.innerHTML =
        `<div class="rname"></div><div class="rblurb"></div>` +
        `<div class="rspecs"></div><div class="rperks"></div>`;
      card.querySelector('.rname').textContent = rig.label;
      card.querySelector('.rblurb').textContent = rig.blurb;
      card.querySelector('.rspecs').textContent = `${rig.modelLabel} · runs ${rig.costHint}`;
      card.querySelector('.rperks').innerHTML = [
        perk(rig.tools.shell, 'workspace'),
        perk(rig.tools.library, 'saved files'),
        perk(rig.tools.browser, 'web browser'),
        perk(rig.reasoning, 'deep thinking'),
      ].join('<br />');
      card.addEventListener('click', () => { draft.rig = rig.id; renderRigs(); syncPreview(); });
      el.rigGrid.appendChild(card);
    }
  }

  /**
   * Access passes. An account is linked once for the whole world, then granted
   * per agent - so the pass card doubles as the place you link it.
   */
  function renderPasses() {
    const grid = $('passGrid');
    grid.textContent = '';
    for (const c of connectors) {
      const linked = Boolean(connections[c.id]?.linked);
      const held = draft.grants.includes(c.id);
      const card = document.createElement('div');
      card.className = 'pass' + (held ? ' on' : '') + (c.available ? '' : ' locked');
      card.innerHTML =
        '<span class="keycard"></span><span><span class="pname2"></span>' +
        '<div class="pallows"></div><span class="plink"></span></span>';
      card.querySelector('.keycard').style.background = c.badge;
      card.querySelector('.pname2').textContent = c.label;
      card.querySelector('.pallows').textContent = c.allows.join(' / ');
      const link = card.querySelector('.plink');

      if (!c.available) {
        link.textContent = 'coming soon';
      } else if (!linked) {
        link.textContent = '[ CONNECT ACCOUNT ]';
        card.addEventListener('click', async () => {
          try {
            connections = await connectAccount(userId, c.id, (m) => { link.textContent = m; });
            onConnections?.(connections);
            draft.grants = [...new Set([...draft.grants, c.id])];
            renderPasses();
            syncPreview();
          } catch (err) {
            console.warn('connect failed:', err);
            link.textContent = err.message;
          }
        });
      } else {
        // A grant lives on the draft until the roster is saved. Saying
        // "granted" for something that would vanish on cancel is how you end
        // up with an agent that swears it has no calendar.
        const live = (roster[editing]?.grants ?? []).includes(c.id);
        link.textContent = held
          ? (live ? 'granted - click to revoke' : 'granted - press SAVE to apply')
          : (live ? 'revoked - press SAVE to apply' : 'click to grant');
        card.classList.toggle('pending', held !== live);
        card.addEventListener('click', () => {
          draft.grants = held
            ? draft.grants.filter((g) => g !== c.id)
            : [...draft.grants, c.id];
          renderPasses();
          syncPreview();
        });
      }
      grid.appendChild(card);
    }
    // Named individually: real Gmail next to a stub calendar is a normal
    // state to be in halfway through wiring one up.
    const demo = connectors.filter((c) => c.available && c.mock).map((c) => c.label);
    $('passHint').textContent = demo.length ? `(demo data: ${demo.join(', ')})` : '';
  }

  // ------------------------------------------------------------ tabs
  /** AGENT is who they are and what they own; LOOK is how they look. */
  function showTab(name) {
    for (const b of el.tabs.querySelectorAll('button')) b.classList.toggle('on', b.dataset.tab === name);
    el.tabAgent.hidden = name !== 'agent';
    el.tabLook.hidden = name !== 'look';
    if (name === 'look') { renderLook(); startStage(); } else stopStage();
  }
  el.tabs.addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) showTab(b.dataset.tab); });

  /**
   * The stage: the agent large, front or back, blinking and breathing, so a
   * change of hat is seen at a size where a hat is a hat.
   */
  let stageRaf = null, stageT = 0, stageView = 'front';
  function paintStage() {
    stageT++;
    if (draft) {
      const ctx = el.lookStage.getContext('2d');
      ctx.clearRect(0, 0, 240, 320);
      const blink = stageT % 160 < 6;
      const bob = Math.sin(stageT / 36) > 0 ? 0 : 1;
      drawDoll(ctx, draft.look, { x: 120, y: 318 + bob, scale: 10, view: stageView, pose: 'stand', blink, sway: Math.round(Math.sin(stageT / 24)) });
    }
    stageRaf = requestAnimationFrame(paintStage);
  }
  function startStage() { if (!stageRaf) stageRaf = requestAnimationFrame(paintStage); }
  function stopStage() { if (stageRaf) cancelAnimationFrame(stageRaf); stageRaf = null; }
  el.lookTurn.addEventListener('click', () => { stageView = stageView === 'front' ? 'back' : 'front'; el.lookTurn.textContent = stageView === 'front' ? 'TURN AROUND' : 'FACE FRONT'; });

  /**
   * The wardrobe, in sections. Style slots show the agent wearing each option
   * at a size where the difference is obvious; colour slots are swatches.
   */
  const LOOK_SECTIONS = [
    ['BODY', [['skin', 'skin tone']]],
    ['HAIR', [['hair', 'style'], ['hairColor', 'colour']]],
    ['OUTFIT', [['top', 'top'], ['topColor', 'top colour'], ['bottom', 'bottom'], ['bottomColor', 'bottom colour'], ['shoes', 'shoes'], ['shoeColor', 'shoe colour']]],
    ['EXTRAS', [['hat', 'hat'], ['hatColor', 'hat colour'], ['glasses', 'glasses']]],
  ];
  /**
   * A thumbnail that is ABOUT its slot: the rest of the outfit is quieted and
   * the view zooms to where the difference is. Hair loses the hat and glasses
   * and shows the head; tops show the torso with long hair tucked away; legs
   * for bottoms and shoes; the face for hats and glasses.
   */
  const THUMB = {
    // slot: [rows from, rows to, scale, overrides]
    hair:    { from: 0,  to: 22, scale: 4, quiet: (l) => ({ ...l, hat: 'none', glasses: 'none' }) },
    top:     { from: 13, to: 27, scale: 4, quiet: (l) => ({ ...l, hat: 'none', hair: ['long', 'ponytail'].includes(l.hair) ? 'short' : l.hair }) },
    bottom:  { from: 21, to: 32, scale: 4, quiet: (l) => ({ ...l, hair: ['long', 'ponytail'].includes(l.hair) ? 'short' : l.hair }) },
    shoes:   { from: 24, to: 32, scale: 5, quiet: (l) => l },
    hat:     { from: 0,  to: 20, scale: 4, quiet: (l) => ({ ...l, glasses: 'none' }) },
    glasses: { from: 3,  to: 18, scale: 5, quiet: (l) => ({ ...l, hat: 'none' }) },
  };
  function thumb(slot, id) {
    const t = THUMB[slot];
    const c = document.createElement('canvas');
    c.width = 24 * t.scale;
    c.height = (t.to - t.from) * t.scale;
    const look = { ...t.quiet(draft.look), [slot]: id };
    // feet-centre placed so doll row `from` lands on the top edge
    drawDoll(c.getContext('2d'), look, { x: c.width / 2, y: (32 - t.from) * t.scale, scale: t.scale, view: 'front', pose: 'stand' });
    return c;
  }

  function renderLook() {
    if (!draft) return;
    el.lookGrid.textContent = '';
    for (const [title, rows] of LOOK_SECTIONS) {
      const sec = document.createElement('div');
      sec.className = 'look-section';
      const h = document.createElement('h4'); h.textContent = title; sec.appendChild(h);
      for (const [slot, label] of rows) {
        const row = document.createElement('div');
        row.className = 'look-row';
        const lab = document.createElement('span'); lab.className = 'look-label'; lab.textContent = label.toUpperCase();
        const opts = document.createElement('div'); opts.className = 'look-opts';
        for (const [id, opt] of Object.entries(CATALOG[slot])) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'look-opt' + (draft.look[slot] === id ? ' on' : '');
          b.title = opt.label;
          if (opt.swatch) {
            const sw = document.createElement('i'); sw.className = 'sw'; sw.style.background = opt.swatch; b.appendChild(sw);
          } else if (id === 'none') {
            const t = THUMB[slot];
            b.classList.add('none'); b.textContent = 'none';
            b.style.width = `${24 * t.scale}px`; b.style.height = `${(t.to - t.from) * t.scale}px`;
          } else {
            b.appendChild(thumb(slot, id));
          }
          b.addEventListener('click', () => { draft.look = { ...draft.look, [slot]: id }; renderLook(); syncPreview(); });
          opts.appendChild(b);
        }
        row.append(lab, opts);
        sec.appendChild(row);
      }
      el.lookGrid.appendChild(sec);
    }
  }

  function renderSkins() {
    el.skinRow.textContent = '';
    for (const skin of catalogue.skins) {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = skin.label;
      b.style.background = skin.body;
      if (draft.colour === skin.id) b.classList.add('on');
      b.addEventListener('click', () => { draft.colour = skin.id; renderSkins(); syncPreview(); });
      el.skinRow.appendChild(b);
    }
  }

  /**
   * Meet the team: the roster as a character-select screen. Each agent stands
   * large and front-facing with its name beneath, blinking and breathing,
   * loose hair swaying. Click one to edit it.
   */
  let teamRaf = null;
  let teamT = 0;
  let teamCards = [];

  function paintTeam() {
    teamT++;
    teamCards.forEach(({ ctx, look }, i) => {
      const k = teamT + i * 37;
      const blink = k % 170 < 6;
      const bob = Math.sin(k / 40) > 0 ? 0 : 1;
      const sway = Math.round(Math.sin(k / 26));
      ctx.clearRect(0, 0, 144, 200);
      drawDoll(ctx, look, { x: 72, y: 196 + bob, scale: 6, view: 'front', pose: 'stand', blink, sway });
    });
    teamRaf = requestAnimationFrame(paintTeam);
  }
  function startTeam() { if (!teamRaf && teamCards.length) teamRaf = requestAnimationFrame(paintTeam); }
  function stopTeam() { if (teamRaf) cancelAnimationFrame(teamRaf); teamRaf = null; }

  function renderRoster() {
    stopTeam();
    teamCards = [];
    el.list.textContent = '';
    el.list.classList.add('team-grid');
    if (!roster.length) {
      const empty = document.createElement('div');
      empty.className = 'lede';
      empty.textContent = 'Nobody works here yet.';
      el.list.appendChild(empty);
    }
    roster.forEach((a, i) => {
      const rig = catalogue.rigs.find((r) => r.id === a.rig);
      const card = document.createElement('div');
      card.className = 'team-card';
      card.innerHTML =
        '<canvas width="144" height="200"></canvas><h3 class="tname"></h3>' +
        '<div class="tmeta"></div><div class="tpasses"></div><button class="fbtn" type="button">EDIT</button>';
      card.querySelector('.tname').textContent = a.name;
      card.querySelector('.tmeta').textContent = `${i === 0 ? 'runs the show' : 'helper'} · ${rig?.label ?? a.rig}`;
      const passes = card.querySelector('.tpasses');
      for (const g of a.grants ?? []) {
        const c = connectors.find((x) => x.id === g);
        const k = document.createElement('i'); k.style.background = c?.badge ?? '#8a82b0'; k.title = c?.label ?? g;
        passes.appendChild(k);
      }
      card.addEventListener('click', () => openEditor(i));
      el.list.appendChild(card);
      teamCards.push({ ctx: card.querySelector('canvas').getContext('2d'), look: lookFor(a) });
    });
    el.newBtn.disabled = roster.length >= catalogue.maxAgents;
    el.newBtn.textContent = roster.length >= catalogue.maxAgents
      ? `ROOM IS FULL (${catalogue.maxAgents})`
      : roster.length === 0 ? '+ BUILD YOUR FIRST AGENT' : '+ HIRE A HELPER';
    if (!el.rosterView.hidden) startTeam();
  }

  // -------------------------------------------------------------- editing
  function openEditor(index) {
    editing = index;
    const existing = index >= 0 ? roster[index] : null;
    draft = {
      name: existing?.name ?? '',
      instructions: existing?.instructions ?? '',
      rig: existing?.rig ?? 'desk',
      colour: existing?.colour ?? catalogue.skins[roster.length % catalogue.skins.length]?.id ?? 'teal',
      grants: Array.isArray(existing?.grants) ? [...existing.grants] : [],
      template: existing?.template ?? '',
    };
    el.template.value = draft.template;
    el.tplHint.textContent = draft.template ? '- its skills ride along' : '';
    // An agent built before the wardrobe existed starts from the look its
    // colour and name imply, so it keeps the face it already has in the room.
    draft.look = { ...lookFor({ ...draft, look: existing?.look }) };
    el.name.value = draft.name;
    el.instr.value = draft.instructions;
    el.instr.placeholder = index > 0 || roster.length
      ? 'You build documents: PDFs, decks, spreadsheets and charts.'
      : 'You are a concise personal assistant. Delegate document work to colleagues.';
    el.deleteBtn.hidden = index < 0;
    el.editErr.textContent = '';
    renderRigs();
    renderSkins();
    renderPasses();
    showTab('agent');
    stopTeam();
    el.rosterView.hidden = true;
    el.editorView.hidden = false;
    syncPreview();
    preview.start();
    el.name.focus();
  }

  function closeEditor() {
    preview.stop();
    stopStage();
    el.editorView.hidden = true;
    el.rosterView.hidden = false;
    renderRoster();
    startTeam();
  }

  async function save(next) {
    const res = await fetch('/api/world', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, agents: next }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Could not save.');
    roster = data.agents;
    onSaved?.(roster);
    return roster;
  }

  el.saveBtn.addEventListener('click', async () => {
    draft.name = el.name.value.trim();
    draft.instructions = el.instr.value.trim();
    const next = roster.map((a) => ({ ...a }));
    if (editing >= 0) next[editing] = { ...next[editing], ...draft };
    else next.push(draft);
    try {
      el.editErr.textContent = 'saving...';
      await save(next);
      closeEditor();
    } catch (err) {
      el.editErr.textContent = err.message;
    }
  });

  el.deleteBtn.addEventListener('click', async () => {
    if (editing < 0) return;
    // Removing the boss promotes the remaining helper; slots renumber server-side.
    const next = roster.filter((_, i) => i !== editing).map((a) => ({ ...a }));
    try {
      el.editErr.textContent = 'removing...';
      await save(next);
      closeEditor();
    } catch (err) {
      el.editErr.textContent = err.message;
    }
  });

  el.name.addEventListener('input', () => { if (draft) { draft.name = el.name.value; syncPreview(); } });

  /**
   * Picking a template fills the form: a name (unless one is typed), the
   * instructions, the computer that suits the job, and the passes it needs
   * among the accounts that are actually linked. The template id stays on
   * the agent so its skill playbooks go into the prompt.
   */
  el.template.addEventListener('change', () => {
    if (!draft) return;
    const role = roles.find((r) => r.id === el.template.value);
    draft.template = role?.id ?? '';
    el.tplHint.textContent = role ? '- its skills ride along' : '';
    if (!role) return;
    if (!el.name.value.trim() || roles.some((r) => r.name === el.name.value.trim())) {
      el.name.value = role.name; draft.name = role.name;
    }
    el.instr.value = role.instructions; draft.instructions = role.instructions;
    draft.rig = role.rig;
    draft.grants = role.grants.filter((g) => connections[g]?.linked);
    renderRigs(); renderPasses(); syncPreview();
  });

  $('cancelEdit').addEventListener('click', closeEditor);
  el.newBtn.addEventListener('click', () => openEditor(-1));

  // ---------------------------------------------------------------- open
  /** @param {number} [index] an agent to go straight into editing. */
  async function open(index) {
    el.panel.classList.add('open');
    el.rosterErr.textContent = 'loading...';
    try {
      const [rigs, shop, world, tpl] = await Promise.all([
        fetch('/api/rigs').then((r) => r.json()),
        fetch('/api/connectors').then((r) => r.json()),
        fetch(`/api/world?userId=${encodeURIComponent(userId)}`).then((r) => r.json()),
        fetch('/api/roles').then((r) => r.json()).catch(() => ({ roles: [] })),
      ]);
      catalogue = { ...rigs, mock: shop.mock };
      roles = tpl.roles ?? [];
      el.template.innerHTML = '<option value="">a blank agent</option>';
      for (const r of roles) {
        const o = document.createElement('option');
        o.value = r.id; o.textContent = `${r.label} - ${r.blurb}`;
        el.template.appendChild(o);
      }
      connectors = shop.connectors ?? [];
      connections = world.connections ?? {};
      onConnections?.(connections);
      roster = world.agents ?? [];
      el.rosterErr.textContent = '';
      closeEditor();
      if (!roster.length) openEditor(-1);   // straight into building the first one
      else if (Number.isInteger(index) && roster[index]) openEditor(index);
    } catch (err) {
      el.rosterErr.textContent = err.message;
    }
  }

  function close() { stopTeam(); stopStage(); el.panel.classList.remove('open'); }

  $('closeFoundry').addEventListener('click', close);
  el.panel.addEventListener('click', (e) => { if (e.target === el.panel) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.panel.classList.contains('open')) close();
  });

  return { open, close, roster: () => roster };
}
