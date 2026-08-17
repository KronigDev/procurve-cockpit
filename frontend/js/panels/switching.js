// Trunks/LACP, spanning tree and port mirroring.

import { api } from '../api.js';
import { propose } from '../changes.js';
import {
  badge, card, checkbox, field, h, input, kv, rawBlock, rawCard, select, table, toast,
} from '../ui.js';

const trunks = {
  id: 'trunks',
  title: 'Trunks / LACP',
  icon: '⇄',
  group: 'Konfiguration',

  async render(root, ctx) {
    const [{ data }, { data: portData }] = await Promise.all([
      api.data('trunks'),
      api.data('ports'),
    ]);
    const refresh = () => ctx.reload();
    const members = data.trunks.data || [];
    const ports = (portData.ports || []).filter((p) => /^\d+$/.test(p.port) || /^[A-Z]\d+$/.test(p.port));

    // Group members by trunk id so the table reads per trunk, not per port.
    const groups = new Map();
    for (const entry of members) {
      if (!groups.has(entry.group)) groups.set(entry.group, { group: entry.group, type: entry.type, ports: [] });
      groups.get(entry.group).ports.push(entry.port);
    }

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'Trunks / Link Aggregation' }),
      h('p', { text: `${groups.size} Trunk-Gruppe(n)` }),
    ));

    root.appendChild(card('Trunk-Gruppen', data.trunks.command, [
      table([
        { key: 'group', label: 'Gruppe', render: (g) => badge(g.group, 'violet') },
        { key: 'type', label: 'Typ' },
        { key: 'ports', label: 'Mitglieder', mono: true, render: (g) => g.ports.join(', ') },
        {
          key: 'x',
          label: '',
          render: (g) => h('button.btn.btn-sm', {
            text: 'Auflösen',
            onclick: () => propose('trunk.delete', { ports: g.ports }).then((ok) => ok && refresh()),
          }),
        },
      ], [...groups.values()]),
      rawBlock(data.trunks),
    ], null, true));

    // -- create -----------------------------------------------------------
    const portPicker = h('select', { multiple: true, size: 8, style: { height: 'auto' } });
    for (const port of ports) {
      portPicker.appendChild(h('option', {
        value: port.port,
        text: `${port.port}${port.name ? ` — ${port.name}` : ''} (${port.up ? 'up' : 'down'})`,
      }));
    }
    const groupInput = input({ value: nextFreeGroup(groups), placeholder: 'trk1' });
    const modeSel = select([['lacp', 'LACP (dynamisch, 802.3ad)'], ['trunk', 'Static Trunk'], ['fec', 'FEC (legacy)']]);

    root.appendChild(card('Neuen Trunk anlegen', null, [
      h('div.grid.cols-2', null,
        field('Mitgliedsports', portPicker, '(Strg/Shift für Mehrfachauswahl)'),
        h('div', null,
          field('Gruppenname', groupInput, '(trk1 … trk24)'),
          field('Modus', modeSel),
          h('div.form-actions', null,
            h('button.btn.btn-primary', {
              text: 'Trunk anlegen',
              onclick: () => {
                const chosen = [...portPicker.selectedOptions].map((o) => o.value);
                if (chosen.length < 2) { toast('Mindestens zwei Ports auswählen.', 'err'); return; }
                propose('trunk.create', {
                  ports: chosen, group: groupInput.value.trim().toLowerCase(), mode: modeSel.value,
                }).then((ok) => ok && refresh());
              },
            }),
          ),
        ),
      ),
    ]));

    root.appendChild(rawCard('LACP-Status', data.lacp));
  },
};

const stp = {
  id: 'stp',
  title: 'Spanning Tree',
  icon: '⑂',
  group: 'Konfiguration',

  async render(root, ctx) {
    const { data } = await api.data('stp');
    const refresh = () => ctx.reload();
    const info = data.stp.data || {};

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'Spanning Tree' }),
      h('p', { text: info.enabled ? `aktiv · ${info.mode || ''}` : 'deaktiviert' }),
    ));

    const enabledSel = select([['', 'unverändert'], ['1', 'aktiviert'], ['0', 'deaktiviert']]);
    const modeSel = select([['', 'unverändert'], ['rstp', 'RSTP (802.1w)'], ['mstp', 'MSTP (802.1s)'], ['stp', 'STP (legacy)']]);
    const prioInput = input({ type: 'number', min: 0, max: 15, placeholder: `aktuell: ${info.priority || '—'}` });
    const mstName = input({ placeholder: 'MST-Region-Name' });
    const mstRev = input({ type: 'number', placeholder: 'MST-Revision' });

    root.appendChild(h('div.grid.cols-2', null,
      card('Globale Einstellungen', null, [
        field('Spanning Tree', enabledSel),
        field('Modus', modeSel),
        field('Bridge-Priorität', prioInput, '(0–15, wird ×4096 gerechnet)'),
        field('MST-Region', mstName),
        field('MST-Revision', mstRev),
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Übernehmen',
            onclick: () => {
              const payload = {};
              if (enabledSel.value) payload.enabled = enabledSel.value === '1';
              if (modeSel.value) payload.mode = modeSel.value;
              if (prioInput.value !== '') payload.priority = Number(prioInput.value);
              if (mstName.value) payload.mst_name = mstName.value;
              if (mstRev.value !== '') payload.mst_revision = Number(mstRev.value);
              if (!Object.keys(payload).length) { toast('Nichts geändert.', 'info'); return; }
              propose('stp.global', payload).then((ok) => ok && refresh());
            },
          }),
        ),
      ]),
      card('Root-Bridge', data.stp.command, [
        kv([
          ['Status', info.enabled ? 'aktiv' : 'inaktiv'],
          ['Modus', info.mode],
          ['Eigene Priorität', info.priority],
          ['Root-MAC', info.root_mac],
          ['Root-Pfadkosten', info.root_path_cost],
          ['Root-Port', info.root_port],
        ]),
      ]),
    ));

    root.appendChild(card('Ports', null, [
      table([
        { key: 'port', label: 'Port', mono: true },
        { key: 'type', label: 'Typ' },
        { key: 'cost', label: 'Kosten', num: true },
        { key: 'priority', label: 'Prio', num: true },
        {
          key: 'state',
          label: 'State',
          render: (p) => badge(p.state || '—',
            /forward/i.test(p.state) ? 'ok' : /block|disab/i.test(p.state) ? 'danger' : 'mute'),
        },
        { key: 'role', label: 'Rolle' },
        { key: 'designated_bridge', label: 'Designated Bridge', mono: true },
      ], info.ports || []),
      rawBlock(data.stp),
      rawBlock(data.config),
      rawBlock(data.mst),
    ], null, true));
  },
};

const mirror = {
  id: 'mirror',
  title: 'Port-Mirroring',
  icon: '⧉',
  group: 'Diagnose',

  async render(root, ctx) {
    const { data: portData } = await api.data('ports');
    const ports = (portData.ports || []).filter((p) => !/^trk/i.test(p.port));
    const refresh = () => ctx.reload();

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'Port-Mirroring' }),
      h('p', { text: 'Verkehr auf einen Analyse-Port spiegeln (SPAN)' }),
    ));

    const sessionSel = select([['1', 'Session 1'], ['2', 'Session 2'], ['3', 'Session 3'], ['4', 'Session 4']]);
    const destSel = select(ports.map((p) => [p.port, `${p.port}${p.name ? ` — ${p.name}` : ''}`]));
    const dirSel = select([['both', 'ein- und ausgehend'], ['in', 'nur eingehend'], ['out', 'nur ausgehend']]);
    const sourcePicker = h('select', { multiple: true, size: 10, style: { height: 'auto' } });
    for (const port of ports) {
      sourcePicker.appendChild(h('option', {
        value: port.port, text: `${port.port}${port.name ? ` — ${port.name}` : ''}`,
      }));
    }

    root.appendChild(card('Spiegelung einrichten', null, [
      h('div.grid.cols-2', null,
        field('Quellports (werden mitgeschnitten)', sourcePicker),
        h('div', null,
          field('Session', sessionSel),
          field('Zielport (Analyzer)', destSel),
          field('Richtung', dirSel),
          h('div.form-actions', null,
            h('button.btn.btn-primary', {
              text: 'Spiegelung aktivieren',
              onclick: () => {
                const sources = [...sourcePicker.selectedOptions].map((o) => o.value);
                if (!sources.length) { toast('Keine Quellports gewählt.', 'err'); return; }
                if (sources.includes(destSel.value)) { toast('Zielport darf keine Quelle sein.', 'err'); return; }
                propose('mirror.set', {
                  session: Number(sessionSel.value), destination: destSel.value,
                  direction: dirSel.value, ports: sources,
                }).then((ok) => ok && refresh());
              },
            }),
            h('button.btn', {
              text: 'Spiegelung entfernen',
              onclick: () => {
                const sources = [...sourcePicker.selectedOptions].map((o) => o.value);
                if (!sources.length) { toast('Quellports wählen, die entfernt werden sollen.', 'err'); return; }
                propose('mirror.set', {
                  session: Number(sessionSel.value), ports: sources, remove: true,
                }).then((ok) => ok && refresh());
              },
            }),
          ),
        ),
      ),
      h('p.note', { text: 'Der Zielport leitet währenddessen keinen normalen Verkehr mehr weiter.' }),
    ]));
  },
};

export default [trunks, stp, mirror];

function nextFreeGroup(groups) {
  for (let i = 1; i <= 24; i += 1) {
    if (!groups.has(`Trk${i}`) && !groups.has(`trk${i}`)) return `trk${i}`;
  }
  return 'trk1';
}
