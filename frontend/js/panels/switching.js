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
  group: 'Configuration',

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
      h('p', { text: `${groups.size} trunk group(s)` }),
    ));

    root.appendChild(card('Trunk groups', data.trunks.command, [
      table([
        { key: 'group', label: 'Group', render: (g) => badge(g.group, 'violet') },
        { key: 'type', label: 'Type' },
        { key: 'ports', label: 'Members', mono: true, render: (g) => g.ports.join(', ') },
        {
          key: 'x',
          label: '',
          render: (g) => h('button.btn.btn-sm', {
            text: 'Dissolve',
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
    const modeSel = select([['lacp', 'LACP (dynamic, 802.3ad)'], ['trunk', 'static trunk'], ['fec', 'FEC (legacy)']]);

    root.appendChild(card('Create a trunk', null, [
      h('div.grid.cols-2', null,
        field('Member ports', portPicker, '(ctrl/shift for multiple)'),
        h('div', null,
          field('Group name', groupInput, '(trk1 … trk24)'),
          field('Mode', modeSel),
          h('div.form-actions', null,
            h('button.btn.btn-primary', {
              text: 'Create trunk',
              onclick: () => {
                const chosen = [...portPicker.selectedOptions].map((o) => o.value);
                if (chosen.length < 2) { toast('Select at least two ports.', 'err'); return; }
                propose('trunk.create', {
                  ports: chosen, group: groupInput.value.trim().toLowerCase(), mode: modeSel.value,
                }).then((ok) => ok && refresh());
              },
            }),
          ),
        ),
      ),
    ]));

    root.appendChild(rawCard('LACP status', data.lacp));
  },
};

const stp = {
  id: 'stp',
  title: 'Spanning Tree',
  icon: '⑂',
  group: 'Configuration',

  async render(root, ctx) {
    const { data } = await api.data('stp');
    const refresh = () => ctx.reload();
    const info = data.stp.data || {};

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'Spanning Tree' }),
      h('p', { text: info.enabled ? `enabled · ${info.mode || ''}` : 'disabled' }),
    ));

    const enabledSel = select([['', 'unchanged'], ['1', 'enabled'], ['0', 'disabled']]);
    const modeSel = select([['', 'unchanged'], ['rstp', 'RSTP (802.1w)'], ['mstp', 'MSTP (802.1s)'], ['stp', 'STP (legacy)']]);
    const prioInput = input({ type: 'number', min: 0, max: 15, placeholder: `current: ${info.priority || '—'}` });
    const mstName = input({ placeholder: 'MST region name' });
    const mstRev = input({ type: 'number', placeholder: 'MST revision' });

    root.appendChild(h('div.grid.cols-2', null,
      card('Global settings', null, [
        field('Spanning Tree', enabledSel),
        field('Mode', modeSel),
        field('Bridge priority', prioInput, '(0–15, multiplied by 4096)'),
        field('MST region', mstName),
        field('MST revision', mstRev),
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Apply',
            onclick: () => {
              const payload = {};
              if (enabledSel.value) payload.enabled = enabledSel.value === '1';
              if (modeSel.value) payload.mode = modeSel.value;
              if (prioInput.value !== '') payload.priority = Number(prioInput.value);
              if (mstName.value) payload.mst_name = mstName.value;
              if (mstRev.value !== '') payload.mst_revision = Number(mstRev.value);
              if (!Object.keys(payload).length) { toast('Nothing changed.', 'info'); return; }
              propose('stp.global', payload).then((ok) => ok && refresh());
            },
          }),
        ),
      ]),
      card('Root bridge', data.stp.command, [
        kv([
          ['Status', info.enabled ? 'enabled' : 'disabled'],
          ['Mode', info.mode],
          ['Own priority', info.priority],
          ['Root MAC', info.root_mac],
          ['Root path cost', info.root_path_cost],
          ['Root port', info.root_port],
        ]),
      ]),
    ));

    root.appendChild(card('Ports', null, [
      table([
        { key: 'port', label: 'Port', mono: true },
        { key: 'type', label: 'Type' },
        { key: 'cost', label: 'Cost', num: true },
        { key: 'priority', label: 'Prio', num: true },
        {
          key: 'state',
          label: 'State',
          render: (p) => badge(p.state || '—',
            /forward/i.test(p.state) ? 'ok' : /block|disab/i.test(p.state) ? 'danger' : 'mute'),
        },
        { key: 'role', label: 'Role' },
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
  title: 'Port mirroring',
  icon: '⧉',
  group: 'Diagnostics',

  async render(root, ctx) {
    const { data: portData } = await api.data('ports');
    const ports = (portData.ports || []).filter((p) => !/^trk/i.test(p.port));
    const refresh = () => ctx.reload();

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'Port mirroring' }),
      h('p', { text: 'Mirror traffic to an analyser port (SPAN)' }),
    ));

    const sessionSel = select([['1', 'Session 1'], ['2', 'Session 2'], ['3', 'Session 3'], ['4', 'Session 4']]);
    const destSel = select(ports.map((p) => [p.port, `${p.port}${p.name ? ` — ${p.name}` : ''}`]));
    const dirSel = select([['both', 'in and out'], ['in', 'inbound only'], ['out', 'outbound only']]);
    const sourcePicker = h('select', { multiple: true, size: 10, style: { height: 'auto' } });
    for (const port of ports) {
      sourcePicker.appendChild(h('option', {
        value: port.port, text: `${port.port}${port.name ? ` — ${port.name}` : ''}`,
      }));
    }

    root.appendChild(card('Set up mirroring', null, [
      h('div.grid.cols-2', null,
        field('Source ports (mirrored)', sourcePicker),
        h('div', null,
          field('Session', sessionSel),
          field('Destination port (analyser)', destSel),
          field('Direction', dirSel),
          h('div.form-actions', null,
            h('button.btn.btn-primary', {
              text: 'Enable mirroring',
              onclick: () => {
                const sources = [...sourcePicker.selectedOptions].map((o) => o.value);
                if (!sources.length) { toast('No source ports selected.', 'err'); return; }
                if (sources.includes(destSel.value)) { toast('The destination port cannot also be a source.', 'err'); return; }
                propose('mirror.set', {
                  session: Number(sessionSel.value), destination: destSel.value,
                  direction: dirSel.value, ports: sources,
                }).then((ok) => ok && refresh());
              },
            }),
            h('button.btn', {
              text: 'Remove mirroring',
              onclick: () => {
                const sources = [...sourcePicker.selectedOptions].map((o) => o.value);
                if (!sources.length) { toast('Select the source ports to remove.', 'err'); return; }
                propose('mirror.set', {
                  session: Number(sessionSel.value), ports: sources, remove: true,
                }).then((ok) => ok && refresh());
              },
            }),
          ),
        ),
      ),
      h('p.note', { text: 'While mirroring, the destination port no longer forwards normal traffic.' }),
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
