/**
 * A small markdown renderer for the task console.
 *
 * Not a spec-complete implementation - just the things agents actually emit:
 * headings, tables, bullet and numbered lists, rules, bold and inline code.
 * Everything is built with DOM nodes and textContent rather than innerHTML,
 * so model output can never inject markup.
 *
 * Tables are the reason this exists: a pipe table printed as plain text in a
 * narrow monospace rail is unreadable.
 */

const BOLD_OR_CODE = /(\*\*[^*]+\*\*|`[^`]+`)/g;

/** Renders bold and inline code into an existing element. */
function inline(el, text) {
  for (const part of String(text).split(BOLD_OR_CODE)) {
    if (!part) continue;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      const b = document.createElement('strong');
      b.textContent = part.slice(2, -2);
      el.appendChild(b);
    } else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      const c = document.createElement('code');
      c.textContent = part.slice(1, -1);
      el.appendChild(c);
    } else {
      el.appendChild(document.createTextNode(part));
    }
  }
  return el;
}

const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
/** The |---|---| line under a table's header. */
const isTableRule = (line) => /^\s*\|[\s:|-]+\|\s*$/.test(line);

const cellsOf = (line) =>
  line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

function buildTable(rows) {
  const wrap = document.createElement('div');
  wrap.className = 'md-tablewrap';
  const table = document.createElement('table');
  table.className = 'md-table';

  let body = rows;
  // A rule on the second line means the first row is a header.
  if (rows.length > 1 && isTableRule(rows[1])) {
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');
    for (const cell of cellsOf(rows[0])) {
      const th = document.createElement('th');
      inline(th, cell);
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    table.appendChild(thead);
    body = rows.slice(2);
  }

  const tbody = document.createElement('tbody');
  for (const row of body) {
    if (isTableRule(row)) continue;
    const tr = document.createElement('tr');
    for (const cell of cellsOf(row)) {
      const td = document.createElement('td');
      inline(td, cell);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

/**
 * Replaces `el`'s contents with rendered markdown.
 * Safe to call on every streamed token: it rebuilds from the whole buffer.
 */
export function renderMarkdown(el, source) {
  el.textContent = '';
  const lines = String(source ?? '').split('\n');

  let i = 0;
  let para = null;

  /** Paragraph text accumulates until a block or a blank line ends it. */
  const flushPara = () => {
    if (para && para.textContent.trim()) el.appendChild(para);
    para = null;
  };

  while (i < lines.length) {
    const line = lines[i];

    // table
    if (isTableRow(line)) {
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(lines[i++]);
      flushPara();
      el.appendChild(buildTable(rows));
      continue;
    }

    // heading
    const heading = line.match(/^\s*(#{1,4})\s+(.*)$/);
    if (heading) {
      flushPara();
      const h = document.createElement('div');
      h.className = `md-h md-h${heading[1].length}`;
      inline(h, heading[2]);
      el.appendChild(h);
      i++;
      continue;
    }

    // horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushPara();
      el.appendChild(document.createElement('hr')).className = 'md-hr';
      i++;
      continue;
    }

    // list, bulleted or numbered
    const listItem = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/);
    if (listItem) {
      const ordered = /^\s*\d/.test(line);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      list.className = 'md-list';
      while (i < lines.length) {
        const m = lines[i].match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/);
        if (!m) break;
        const li = document.createElement('li');
        inline(li, m[1]);
        list.appendChild(li);
        i++;
      }
      flushPara();
      el.appendChild(list);
      continue;
    }

    // blank line ends a paragraph
    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }

    if (!para) {
      para = document.createElement('div');
      para.className = 'md-p';
    } else {
      para.appendChild(document.createTextNode('\n'));
    }
    inline(para, line);
    i++;
  }

  flushPara();
  return el;
}
