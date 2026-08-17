// Port management: pick ports on the faceplate (or in the table), then act on
// the whole selection at once. Every action goes through the change preview.

import { api } from '../api.js';
import { propose } from '../changes.js';
import { applySelection, faceplate, legend } from '../faceplate.js';
import {
  badge, card, checkbox, field, h, input, rawBlock, segmented, select, table, toast,
} from '../ui.js';

const selected = new Set();
const lastClicked = { value: null };
let colorBy = 'status';
let filterText = '';

export default {
  id: 'ports',
  title: 'Ports',
  icon: '▦',
  group: 'Konfiguration',

  async render(root, ctx) {
    const [{ data: portData }, { data: vlanData }] = await Promise.all([
      api.data('ports'),
      api.data('vlans'),
    ]);
    const ports = portData.ports || [];
    const vlans = vlanData.vlans || [];

    // Drop selections for ports that no longer exist (module pulled, etc.).
    for (const id of [...selected]) {
      if (!ports.some((p) => p.port === id)) selected.delete(id);
    }

    const refresh = () => ctx.reload();
    // Re-colouring is purely visual — assigned once the drawing helpers below
    // exist, so switching the colour mode never re-queries the switch.
    let recolour = () => {};

    const COLOR_MODES = [['status', 'Status'], ['vlan', 'VLAN'], ['speed', 'Speed'], ['poe', 'PoE']];
    const colorSeg = segmented(COLOR_MODES, colorBy, (value) => { colorBy = value; recolour(); });

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'Ports' }),
      h('p', { text: `${ports.length} Ports · ${ports.filter((p) => p.up).length} up` }),
      h('span.spacer'),
      h('div.fp-colorby', null,
        h('span.muted', { text: 'Einfärben nach' }),
        colorSeg,
      ),
    ));

    // ── faceplate ──────────────────────────────────────────────────────
    const fpWrap = h('div');
    const drawFaceplate = () => {
      fpWrap.replaceChildren(
        faceplate(ports, {
          selected,
          colorBy,
          onToggle: (port, ev) => {
            applySelection(selected, ports, port, ev, lastClicked);
            drawFaceplate();
            drawInspector();
            markTable();
          },
        }),
        legend(colorBy),
      );
    };
    drawFaceplate();

    recolour = () => {
      drawFaceplate();
      for (const [index, button] of [...colorSeg.querySelectorAll('button')].entries()) {
        button.classList.toggle('on', COLOR_MODES[index][0] === colorBy);
      }
    };

    const selectionTools = h('div.toolbar', null,
      h('button.btn.btn-sm', { text: 'Alle', onclick: () => {
        ports.forEach((p) => selected.add(p.port)); drawFaceplate(); drawInspector(); markTable();
      } }),
      h('button.btn.btn-sm', { text: 'Keine', onclick: () => {
        selected.clear(); drawFaceplate(); drawInspector(); markTable();
      } }),
      h('button.btn.btn-sm', { text: 'Nur Up', onclick: () => {
        selected.clear(); ports.filter((p) => p.up).forEach((p) => selected.add(p.port));
        drawFaceplate(); drawInspector(); markTable();
      } }),
      h('button.btn.btn-sm', { text: 'Nur Down', onclick: () => {
        selected.clear(); ports.filter((p) => !p.up).forEach((p) => selected.add(p.port));
        drawFaceplate(); drawInspector(); markTable();
      } }),
      h('span.spacer'),
      h('span.sel-summary', { id: 'sel-summary', text: '' }),
    );

    // ── inspector ──────────────────────────────────────────────────────
    const inspector = h('div.card.inspector', null,
      h('header', null, h('h3', { text: 'Auswahl bearbeiten' })),
      h('div.card-body', { id: 'insp-body' }),
    );

    const drawInspector = () => {
      const body = inspector.querySelector('#insp-body');
      const summary = selectionTools.querySelector('#sel-summary');
      const chosen = ports.filter((p) => selected.has(p.port));
      summary.textContent = chosen.length ? `${chosen.length} ausgewählt: ${compact(chosen)}` : '';

      if (!chosen.length) {
        body.replaceChildren(h('p.note', {
          text: 'Ports auf der Frontblende anklicken. Shift-Klick wählt einen Bereich.',
        }));
        return;
      }
      body.replaceChildren(...buildInspector(chosen, vlans, ports, refresh));
    };
    drawInspector();

    // ── table ──────────────────────────────────────────────────────────
    const tableHost = h('div');
    const markTable = () => {
      for (const tr of tableHost.querySelectorAll('tr[data-port]')) {
        tr.classList.toggle('sel', selected.has(tr.dataset.port));
      }
    };
    const drawTable = () => {
      const needle = filterText.trim().toLowerCase();
      const rows = needle
        ? ports.filter((p) => JSON.stringify(p).toLowerCase().includes(needle))
        : ports;
      const node = table([
        { key: 'port', label: 'Port', mono: true },
        { key: 'name', label: 'Name' },
        { key: 'type', label: 'Typ' },
        {
          key: 'status',
          label: 'Status',
          render: (p) => p.enabled === false
            ? badge('deaktiviert', 'danger')
            : badge(p.up ? 'up' : 'down', p.up ? 'ok' : 'mute'),
        },
        { key: 'mode', label: 'Mode' },
        {
          key: 'vlan',
          label: 'VLANs',
          render: (p) => h('span', null,
            p.untagged ? h('span.vlan-pill.untag', { text: `U${p.untagged}` }) : null,
            ...(p.tagged || []).map((v) => h('span.vlan-pill', { text: `T${v}` })),
          ),
        },
        { key: 'trunk', label: 'Trunk', render: (p) => p.trunk ? badge(p.trunk.group, 'violet') : '' },
        {
          key: 'lldp',
          label: 'Nachbar (LLDP)',
          render: (p) => p.lldp ? (p.lldp.system_name || p.lldp.chassis_id) : '',
        },
        { key: 'flow_control', label: 'Flow' },
      ], rows, {
        onRow: (p) => {
          if (selected.has(p.port)) selected.delete(p.port); else selected.add(p.port);
          lastClicked.value = p.port;
          drawFaceplate(); drawInspector(); markTable();
        },
      });
      for (const [index, tr] of [...node.querySelectorAll('tbody tr')].entries()) {
        tr.dataset.port = rows[index].port;
      }
      tableHost.replaceChildren(node);
      markTable();
    };

    const search = input({
      type: 'search',
      placeholder: 'Filter: Name, VLAN, Nachbar …',
      value: filterText,
      oninput: (ev) => { filterText = ev.target.value; drawTable(); },
    });
    drawTable();

    root.appendChild(card(null, null, [fpWrap, selectionTools], null));
    root.appendChild(h('div.split', null,
      h('div', null,
        card('Portliste', `${ports.length} Einträge`, [
          h('div.toolbar', null, search),
          tableHost,
          rawBlock(portData.sources?.brief),
          rawBlock(portData.sources?.names),
        ], null, false),
      ),
      inspector,
    ));
  },
};

function compact(ports) {
  const nums = ports.map((p) => p.port).filter((p) => /^\d+$/.test(p)).map(Number).sort((a, b) => a - b);
  const other = ports.map((p) => p.port).filter((p) => !/^\d+$/.test(p));
  const out = [];
  let start = null; let prev = null;
  for (const n of nums) {
    if (start === null) { start = prev = n; }
    else if (n === prev + 1) prev = n;
    else { out.push(start === prev ? `${start}` : `${start}-${prev}`); start = prev = n; }
  }
  if (start !== null) out.push(start === prev ? `${start}` : `${start}-${prev}`);
  return [...out, ...other].join(',');
}

function buildInspector(chosen, vlans, allPorts, refresh) {
  const ids = chosen.map((p) => p.port);
  const nodes = [];

  nodes.push(h('div.chip', { text: `${ids.length} Port(s): ${compact(chosen)}` }));

  // -- quick enable/disable ------------------------------------------------
  nodes.push(h('div.form-actions', null,
    h('button.btn.btn-sm', {
      text: 'Aktivieren',
      onclick: () => propose('port.settings', { ports: ids, enabled: true }).then((ok) => ok && refresh()),
    }),
    h('button.btn.btn-sm', {
      text: 'Deaktivieren',
      onclick: () => propose('port.settings', { ports: ids, enabled: false }).then((ok) => ok && refresh()),
    }),
  ));

  // -- name / speed / misc -------------------------------------------------
  const nameInput = input({
    placeholder: chosen.length === 1 ? (chosen[0].name || 'Portname') : 'Name für alle',
    value: chosen.length === 1 ? (chosen[0].name || '') : '',
  });
  const speedSel = select([
    ['', 'unverändert'], ['auto', 'auto'], ['auto-10', 'auto-10'], ['auto-100', 'auto-100'],
    ['auto-1000', 'auto-1000'], ['10-half', '10 half'], ['10-full', '10 full'],
    ['100-half', '100 half'], ['100-full', '100 full'], ['1000-full', '1000 full'],
  ]);
  const flowSel = select([['', 'unverändert'], ['1', 'ein'], ['0', 'aus']]);
  const mdiSel = select([['', 'unverändert'], ['auto-mdix', 'auto-mdix'], ['mdi', 'mdi'], ['mdix', 'mdix']]);
  const lldpSel = select([
    ['', 'unverändert'], ['tx_rx', 'tx + rx'], ['tx_only', 'nur tx'],
    ['rx_only', 'nur rx'], ['disable', 'aus'],
  ]);
  const bcastInput = input({ type: 'number', min: 0, max: 99, placeholder: 'unverändert' });

  nodes.push(field('Portname', nameInput, '(leer = Name entfernen)'));
  nodes.push(field('Speed / Duplex', speedSel));
  nodes.push(field('Flow Control', flowSel));
  nodes.push(field('MDI-Modus', mdiSel));
  nodes.push(field('LLDP', lldpSel));
  nodes.push(field('Broadcast-Limit', bcastInput, '% (0 = aus)'));

  nodes.push(h('div.form-actions', null,
    h('button.btn.btn-primary', {
      text: 'Porteinstellungen übernehmen',
      onclick: () => {
        const payload = { ports: ids };
        if (nameInput.value !== (chosen.length === 1 ? (chosen[0].name || '') : '')) {
          payload.name = nameInput.value;
        }
        if (speedSel.value) payload.speed_duplex = speedSel.value;
        if (flowSel.value) payload.flow_control = flowSel.value === '1';
        if (mdiSel.value) payload.mdix_mode = mdiSel.value;
        if (lldpSel.value) payload.lldp_admin = lldpSel.value;
        if (bcastInput.value !== '') payload.broadcast_limit = Number(bcastInput.value);
        if (Object.keys(payload).length === 1) { toast('Nichts geändert.', 'info'); return; }
        propose('port.settings', payload).then((ok) => ok && refresh());
      },
    }),
  ));

  // -- VLAN membership -----------------------------------------------------
  const vlanOptions = [['', '— nicht ändern —'],
    ...vlans.map((v) => [String(v.id), `${v.id} · ${v.name}`])];
  const untaggedSel = select(vlanOptions);
  const taggedAdd = select(vlanOptions);
  const taggedDel = select(vlanOptions);

  nodes.push(h('hr', { style: { border: 'none', borderTop: '1px solid var(--line-soft)', margin: '4px 0' } }));
  nodes.push(h('h4', { text: 'VLAN-Zuordnung', style: { fontSize: '12px', color: 'var(--fg-dim)' } }));
  nodes.push(field('Untagged (Access-VLAN)', untaggedSel));
  nodes.push(field('Tagged hinzufügen', taggedAdd));
  nodes.push(field('Tagged entfernen', taggedDel));
  nodes.push(h('div.form-actions', null,
    h('button.btn.btn-primary', {
      text: 'VLANs übernehmen',
      onclick: () => {
        const payload = { ports: ids };
        if (untaggedSel.value) {
          payload.untagged = Number(untaggedSel.value);
          // Tell the backend the previous untagged VLAN of each port so it can
          // release it first — ProVision refuses two untagged memberships.
          payload.current_untagged = Object.fromEntries(
            chosen.filter((p) => p.untagged).map((p) => [p.port, p.untagged]),
          );
        }
        if (taggedAdd.value) payload.tagged_add = [Number(taggedAdd.value)];
        if (taggedDel.value) payload.tagged_remove = [Number(taggedDel.value)];
        if (Object.keys(payload).length === 1) { toast('Kein VLAN ausgewählt.', 'info'); return; }
        propose('port.vlans', payload).then((ok) => ok && refresh());
      },
    }),
  ));

  // -- spanning tree per port ---------------------------------------------
  const edge = checkbox('Admin-Edge-Port (PortFast)', false);
  const bpdu = checkbox('BPDU-Protection', false);
  const rootGuard = checkbox('Root-Guard', false);
  const costInput = input({ type: 'number', placeholder: 'Pfadkosten (leer = auto)' });

  nodes.push(h('hr', { style: { border: 'none', borderTop: '1px solid var(--line-soft)', margin: '4px 0' } }));
  nodes.push(h('h4', { text: 'Spanning Tree', style: { fontSize: '12px', color: 'var(--fg-dim)' } }));
  nodes.push(edge.el, bpdu.el, rootGuard.el, field('Pfadkosten', costInput));
  nodes.push(h('div.form-actions', null,
    h('button.btn.btn-sm', {
      text: 'STP übernehmen',
      onclick: () => {
        const payload = { ports: ids };
        if (edge.input.checked) payload.admin_edge = true;
        if (bpdu.input.checked) payload.bpdu_protection = true;
        if (rootGuard.input.checked) payload.root_guard = true;
        if (costInput.value !== '') payload.path_cost = Number(costInput.value);
        if (Object.keys(payload).length === 1) { toast('Nichts ausgewählt.', 'info'); return; }
        propose('stp.port', payload).then((ok) => ok && refresh());
      },
    }),
    h('button.btn.btn-sm', {
      text: 'Edge/Guard entfernen',
      onclick: () => propose('stp.port', {
        ports: ids, admin_edge: false, bpdu_protection: false, root_guard: false,
      }).then((ok) => ok && refresh()),
    }),
  ));

  return nodes;
}
