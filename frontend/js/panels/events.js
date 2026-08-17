// Event log as a real table: severity chips, system filter, text search.

import { api } from '../api.js';
import { badge, card, h, input, rawBlock, select, table, toast } from '../ui.js';
import { downloadText } from './system.js';

const SEV_KIND = { M: 'danger', W: 'warn', I: 'info', D: 'mute' };
const SEV_NAME = { M: 'major', W: 'warning', I: 'info', D: 'debug' };
const SEV_ORDER = ['M', 'W', 'I', 'D'];

export function sevBadge(entry) {
  return badge(entry.severity_name || entry.severity, SEV_KIND[entry.severity] || 'mute');
}

const COLUMNS = [
  { key: 'severity', label: 'Sev', render: sevBadge },
  { key: 'date', label: 'Date', mono: true },
  { key: 'time', label: 'Time', mono: true },
  { key: 'code', label: 'Code', mono: true, num: true },
  { key: 'module', label: 'System', mono: true },
  { key: 'message', label: 'Event' },
];

export default {
  id: 'events',
  title: 'Event log',
  icon: '☲',
  group: 'Status',

  async render(root, ctx) {
    const { data } = await api.data('logging');
    let logFetch = data.log;
    let entries = logFetch.data || [];
    let raw = logFetch.raw || '';

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'Event log' }),
      h('p', { text: `${data.log.command} — newest first` }),
    ));

    // ── filter state ────────────────────────────────────────────────────
    let needle = '';
    let module = '';
    let limit = 200;
    const sevOff = new Set(); // letters currently hidden

    const summary = h('span.chip');
    const host = h('div');
    const diag = h('div'); // raw fallback when the parser found nothing

    const matches = (e) =>
      !sevOff.has(e.severity)
      && (!module || e.module === module)
      && (!needle
        || `${e.date} ${e.time} ${e.code} ${e.module} ${e.message}`.toLowerCase().includes(needle));

    const draw = () => {
      const filtered = entries.filter(matches);
      const shown = limit ? filtered.slice(0, limit) : filtered;
      let text = filtered.length === entries.length
        ? `${entries.length} events`
        : `${filtered.length} of ${entries.length} events`;
      if (shown.length < filtered.length) text += ` (showing ${shown.length})`;
      summary.textContent = text;
      host.replaceChildren(table(COLUMNS, shown, {
        emptyText: entries.length ? 'No events match the filters.' : 'The event log is empty.',
      }));
      // Tracks every refresh: appears when a fetch parses to nothing,
      // disappears again once entries come back.
      diag.replaceChildren();
      if (!entries.length) {
        diag.appendChild(rawBlock(logFetch, 'Parser found no entries — raw output for diagnosis'));
      }
    };

    // ── severity chips ──────────────────────────────────────────────────
    // Chips and the system dropdown are rebuilt on every refresh so their
    // counts and options track the data instead of the initial fetch.
    const sevWrap = h('div.seg');
    const chips = new Map(); // severity letter -> button
    const chipLabel = (sev) => {
      const count = entries.filter((e) => e.severity === sev).length;
      return `${SEV_NAME[sev] || sev}${count ? ` ${count}` : ''}`;
    };
    const ensureChip = (sev) => {
      if (chips.has(sev)) return;
      const btn = h('button', {
        class: 'on',
        text: chipLabel(sev),
        title: `Show/hide ${SEV_NAME[sev] || sev} events`,
        onclick: () => {
          if (sevOff.has(sev)) sevOff.delete(sev); else sevOff.add(sev);
          btn.classList.toggle('on', !sevOff.has(sev));
          draw();
        },
      });
      chips.set(sev, btn);
      sevWrap.appendChild(btn);
    };

    const moduleSel = h('select', {
      onchange: (ev) => { module = ev.target.value; draw(); },
    });

    const updateFilters = () => {
      for (const sev of SEV_ORDER) ensureChip(sev);
      for (const sev of [...new Set(entries.map((e) => e.severity))].sort()) ensureChip(sev);
      for (const [sev, btn] of chips) btn.textContent = chipLabel(sev);
      const modules = [...new Set(entries.map((e) => e.module))].sort();
      if (module && !modules.includes(module)) module = '';
      moduleSel.replaceChildren(
        ...[['', 'all systems'], ...modules.map((m) => [m, m])]
          .map(([value, label]) => h('option', { value, text: label })),
      );
      moduleSel.value = module;
    };
    updateFilters();
    const limitSel = select(
      [['100', 'last 100'], ['200', 'last 200'], ['500', 'last 500'], ['0', 'everything']],
      { value: '200', onchange: (ev) => { limit = Number(ev.target.value); draw(); } },
    );

    root.appendChild(card('Events', null, [
      h('div.toolbar', null,
        input({
          type: 'search', placeholder: 'Search text, code, system …',
          oninput: (ev) => { needle = ev.target.value.trim().toLowerCase(); draw(); },
        }),
        sevWrap,
        moduleSel,
        limitSel,
        h('span.spacer'),
        summary,
        h('button.btn.btn-sm', {
          text: 'Refresh',
          onclick: () => refresh().catch((err) => toast('Refresh failed', 'err', err.message)),
        }),
        h('button.btn.btn-sm', {
          text: 'Download',
          onclick: () => downloadText('switch-events.txt', raw || '(empty)'),
        }),
      ),
      host,
      diag,
    ]));

    draw();

    // Refresh re-fetches but keeps every filter as it is.
    const refresh = async () => {
      const fresh = await api.data('logging');
      logFetch = fresh.data.log;
      entries = logFetch.data || [];
      raw = logFetch.raw || '';
      updateFilters();
      draw();
    };

    // ── auto refresh ────────────────────────────────────────────────────
    const auto = h('input', { type: 'checkbox' });
    root.querySelector('.toolbar').appendChild(
      h('label.check', { style: { margin: '0' } }, auto, h('span', { text: 'auto (30 s)' })),
    );
    const timer = setInterval(() => {
      if (auto.checked) refresh().catch(() => { /* transient -- next tick retries */ });
    }, 30000);
    return () => clearInterval(timer);
  },
};
