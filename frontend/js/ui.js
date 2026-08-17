// DOM helpers, toasts and the reusable render pieces every panel uses.

/** Create an element: h('div.card', {onclick}, child, child...) */
export function h(spec, props = null, ...children) {
  const [tagPart, ...classes] = String(spec).split('.');
  const el = document.createElement(tagPart || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = `${el.className} ${value}`.trim();
      else if (key === 'html') el.innerHTML = value;
      else if (key === 'text') el.textContent = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, value);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

/** Escape for the rare place we build HTML strings (diff rendering). */
export function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── toasts ────────────────────────────────────────────────────────────

export function toast(message, kind = 'info', detail = '', ms = 4200) {
  const box = h(`div.toast.${kind}`, null,
    h('div', { text: message }),
    detail ? h('div.t-detail', { text: detail }) : null,
  );
  document.getElementById('toasts').appendChild(box);
  setTimeout(() => {
    box.style.transition = 'opacity .25s, transform .25s';
    box.style.opacity = '0';
    box.style.transform = 'translateX(16px)';
    setTimeout(() => box.remove(), 260);
  }, ms);
}

export function setStatus(message) {
  const el = document.getElementById('status-msg');
  if (el) el.textContent = message || '';
}

export function setBusy(busy) {
  const dot = document.getElementById('conn-dot');
  if (dot) dot.classList.toggle('busy', !!busy);
}

// ── modal ─────────────────────────────────────────────────────────────

let modalCleanup = null;

export function openModal(title, bodyNodes, footNodes, onClose) {
  const backdrop = document.getElementById('modal');
  document.getElementById('modal-title').textContent = title;
  const body = clear(document.getElementById('modal-body'));
  const foot = clear(document.getElementById('modal-foot'));
  append(body, [bodyNodes]);
  append(foot, [footNodes]);
  backdrop.hidden = false;
  modalCleanup = onClose || null;
  return backdrop;
}

export function closeModal() {
  document.getElementById('modal').hidden = true;
  if (modalCleanup) { const fn = modalCleanup; modalCleanup = null; fn(); }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal').addEventListener('click', (ev) => {
    if (ev.target.id === 'modal') closeModal();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !document.getElementById('modal').hidden) closeModal();
  });
});

// ── shared render pieces ──────────────────────────────────────────────

export function card(title, subtitle, bodyNodes, headerExtra = null, tight = false) {
  return h('div.card', null,
    (title || headerExtra) ? h('header', null,
      title ? h('h3', { text: title }) : null,
      subtitle ? h('span.muted', { text: subtitle }) : null,
      h('span.spacer'),
      headerExtra,
    ) : null,
    h(`div.card-body${tight ? '.tight' : ''}`, null, bodyNodes),
  );
}

export function stat(label, value, sub, kind = '') {
  return h(`div.stat${kind ? '.' + kind : ''}`, null,
    h('div.label', { text: label }),
    h('div.value', { text: value ?? '—' }),
    sub ? h('div.sub', { text: sub }) : null,
  );
}

export function kv(pairs) {
  const list = h('dl.kv');
  for (const [key, value] of pairs) {
    if (value === null || value === undefined || value === '') continue;
    list.appendChild(h('dt', { text: key }));
    list.appendChild(h('dd', { text: String(value) }));
  }
  return list;
}

export function loading(text = 'Loading …') {
  return h('div.loading', null, h('div.spinner'), h('span', { text }));
}

export function empty(text) {
  return h('div.empty', { text });
}

/**
 * Render a table.
 * columns: [{key, label, num?, render?(row)}]
 */
export function table(columns, rows, options = {}) {
  if (!rows || !rows.length) return empty(options.emptyText || 'No entries.');
  const thead = h('thead', null, h('tr', null,
    // A label may be a node (a select-all checkbox, an icon) as well as text.
    columns.map((col) => col.label instanceof Node
      ? h(`th${col.num ? '.num' : ''}`, null, col.label)
      : h(`th${col.num ? '.num' : ''}`, { text: col.label })),
  ));
  const tbody = h('tbody');
  for (const row of rows) {
    const tr = h(`tr${options.onRow ? '.clickable' : ''}`, options.onRow
      ? { onclick: () => options.onRow(row, tr) } : null);
    for (const col of columns) {
      const cell = h(`td${col.num ? '.num' : ''}${col.mono ? '.mono' : ''}`);
      const value = col.render ? col.render(row) : row[col.key];
      if (value instanceof Node) cell.appendChild(value);
      else cell.textContent = value === null || value === undefined || value === '' ? '—' : String(value);
      tr.appendChild(cell);
    }
    if (options.rowClass) tr.className += ' ' + (options.rowClass(row) || '');
    tbody.appendChild(tr);
  }
  return h('div.table-wrap', null, h('table.tbl', null, thead, tbody));
}

export function badge(text, kind = 'mute') {
  return h(`span.badge.badge-${kind}`, { text });
}

/**
 * Collapsible raw CLI output — the fallback whenever a parser is unsure.
 * `fetch` is the {command, raw, error} envelope the backend returns.
 */
function rawBody(fetchObj) {
  // When the reply is empty, fall back to the untrimmed transcript. A bare
  // "(empty)" tells you nothing about *why* — the transcript shows whether the
  // switch stayed silent, rejected the command, or answered something we then
  // trimmed away by mistake.
  if (fetchObj.raw) return h('pre.raw', { text: fetchObj.raw });
  if (fetchObj.transcript) {
    return h('div', null,
      h('p.note', { text: 'Command returned nothing. Full transcript, echo and prompt included:' }),
      h('pre.raw', { text: fetchObj.transcript }),
    );
  }
  return h('pre.raw', { text: '(empty)' });
}

export function rawBlock(fetchObj, label = null) {
  if (!fetchObj) return null;
  const cmd = fetchObj.command || '';
  return h('details.raw-toggle', null,
    h('summary', { text: label || `Raw output: ${cmd}` }),
    fetchObj.error
      ? h('div.risk.warn', null, h('b', { text: 'Switch:' }), h('span', { text: fetchObj.error }))
      : null,
    rawBody(fetchObj),
  );
}

/** A card that just shows one command's raw output — used for the long-tail panels. */
export function rawCard(title, fetchObj) {
  if (!fetchObj) return null;
  return card(title, fetchObj.command, [
    fetchObj.error
      ? h('div.risk.warn', null, h('b', { text: 'Switch:' }), h('span', { text: fetchObj.error }))
      : null,
    rawBody(fetchObj),
  ]);
}

/** A table built from generic {headers, rows} with its own filter box. */
export function filterableTable(headers, rows) {
  const columns = (headers || []).map((name) => ({ key: name, label: name }));
  const host = h('div');
  const draw = (needle) => {
    const shown = needle
      ? rows.filter((r) => Object.values(r).join(' ').toLowerCase().includes(needle))
      : rows;
    host.replaceChildren(table(columns, shown, { emptyText: 'No rows match the filter.' }));
  };
  draw('');
  if ((rows || []).length <= 6) return host; // a filter over 6 rows is noise
  return h('div', null,
    h('div.toolbar', null,
      input({
        type: 'search',
        placeholder: `Filter ${rows.length} rows …`,
        oninput: (ev) => draw(ev.target.value.trim().toLowerCase()),
      }),
    ),
    host,
  );
}

/**
 * Render the generic backend structure ({kv, tables}) as real elements —
 * key/value list plus one filterable table per table found. The raw text only
 * appears collapsed at the bottom, as the escape hatch it should be.
 */
export function structured(fetchObj) {
  const wrap = h('div');
  if (!fetchObj) return wrap;
  if (fetchObj.error) {
    wrap.appendChild(h('div.risk.warn', null,
      h('b', { text: 'Switch:' }), h('span', { text: fetchObj.error })));
  }
  const data = fetchObj.data || {};
  const kvPairs = Object.entries(data.kv || {});
  const tables = data.tables || [];
  if (kvPairs.length) wrap.appendChild(kv(kvPairs));
  for (const t of tables) wrap.appendChild(filterableTable(t.headers, t.rows || []));
  if (!kvPairs.length && !tables.length && !fetchObj.error) {
    const text = (fetchObj.raw || '').trim();
    if (!text) {
      wrap.appendChild(empty('The switch returned nothing.'));
    } else {
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length <= 5) {
        // Short answers become status tiles, never console text.
        wrap.appendChild(h('div.facts', null, lines.map((lineText) => h('div.fact', null,
          /^(enabled|disabled|yes|no|on|off|active|inactive)[.!]?$/i.test(lineText)
            ? badge(lineText, /^(enab|yes|on|act)/i.test(lineText) ? 'ok' : 'mute')
            : h('div.value', { text: lineText }),
        ))));
      } else {
        wrap.appendChild(h('pre.raw', { text }));
      }
    }
  }
  wrap.appendChild(rawBlock(fetchObj));
  return wrap;
}

/** Card wrapper for `structured` — the drop-in replacement for rawCard. */
export function structCard(title, fetchObj) {
  if (!fetchObj) return null;
  return card(title, fetchObj.command, structured(fetchObj));
}

/**
 * A form control bound to the value the switch currently reports.
 * The control opens ON that value (never on an "unchanged" placeholder), the
 * label carries a ● marker while the control differs from it, and submit
 * handlers use `changed()` to send only fields that actually moved.
 * For selects whose current value is not among the options, a "(as reported)"
 * entry is inserted so the truth is always visible.
 */
export function tracked(labelText, control, currentValue, hint = '') {
  const baseline = currentValue === null || currentValue === undefined
    ? '' : String(currentValue);
  if (control.tagName === 'SELECT') {
    const known = [...control.options].some((o) => o.value === baseline);
    if (!known) {
      control.insertBefore(
        h('option', {
          value: baseline,
          text: baseline ? `${baseline} (as reported)` : '— unknown —',
        }),
        control.firstChild,
      );
    }
    control.value = baseline;
  } else if ('value' in control) {
    control.value = baseline;
  }
  const marker = h('span.dirty-dot', {
    text: '●',
    title: 'Changed here — not yet staged or applied to the switch',
  });
  marker.hidden = true;
  const update = () => { marker.hidden = String(control.value) === baseline; };
  control.addEventListener('input', update);
  control.addEventListener('change', update);
  const el = h('label.field', null,
    h('span', null, labelText, marker, hint ? h('em', { text: ` ${hint}` }) : null),
    control,
  );
  return { el, control, baseline, changed: () => String(control.value) !== baseline };
}

/** Key/value pairs as a grid of readable tiles instead of a cramped list. */
export function facts(pairs, monoKeys = []) {
  const grid = h('div.facts');
  for (const [label, value] of pairs) {
    if (value === null || value === undefined || value === '') continue;
    grid.appendChild(h('div.fact', null,
      h('div.label', { text: label, title: label }),
      h(`div.value${monoKeys.includes(label) ? '.mono' : ''}`, { text: String(value) }),
    ));
  }
  return grid;
}

export function field(labelText, control, hint = '') {
  return h('label.field', null,
    h('span', null, labelText, hint ? h('em', { text: ` ${hint}` }) : null),
    control,
  );
}

export function input(props = {}) { return h('input', props); }

export function select(options, props = {}) {
  const el = h('select', props);
  for (const opt of options) {
    const [value, label] = Array.isArray(opt) ? opt : [opt, opt];
    el.appendChild(h('option', { value, text: label, selected: props.value === value }));
  }
  if (props.value !== undefined) el.value = props.value;
  return el;
}

export function checkbox(labelText, checked, props = {}) {
  const box = h('input', { type: 'checkbox', checked: !!checked, ...props });
  return { el: h('label.check', null, box, h('span', { text: labelText })), input: box };
}

/** Tri-state select for "leave alone / on / off" port settings. */
export function triState(labelText, props = {}) {
  return field(labelText, select([['', 'unchanged'], ['1', 'on'], ['0', 'off']], props));
}

export function segmented(options, current, onChange) {
  const wrap = h('div.seg');
  for (const [value, label] of options) {
    wrap.appendChild(h('button', {
      class: value === current ? 'on' : '',
      text: label,
      onclick: () => onChange(value),
    }));
  }
  return wrap;
}

export function bytesToMb(value) {
  const num = Number(String(value ?? '').replace(/[,\s]/g, ''));
  if (!Number.isFinite(num) || num <= 0) return null;
  return num / (1024 * 1024);
}

export function formatUptime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const d = Math.floor(seconds / 86400);
  const h_ = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h_}h`;
  if (h_) return `${h_}h ${m}m`;
  return `${m}m`;
}
