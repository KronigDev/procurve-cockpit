// Port management: pick ports on the faceplate (or in the table), then act on
// the whole selection at once. Every action goes through the change preview.

import { api } from '../api.js';
import { propose } from '../changes.js';
import { applySelection, faceplate, legend } from '../faceplate.js';
import {
  badge, card, checkbox, field, h, input, kv, rawBlock, segmented, select, table, toast,
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
          rawBlock(portData.sources?.config),
          rawBlock(portData.sources?.names),
          rawBlock(portData.sources?.lldp_config),
          rawBlock(portData.sources?.stp_config),
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

// ── current state of a selection ──────────────────────────────────────
//
// Every control below starts on what the switch is *configured* to do, not on
// "unverändert". The catch: preselecting must not turn into a change. So each
// control remembers the value it started with (`baseline`) and the submit
// handlers send a field only when it actually moved away from that baseline.

/** The value shared by the whole selection, or `mixed` when they disagree. */
function common(items, pick) {
  const values = items.map((item) => {
    const v = pick(item);
    return v === null || v === undefined ? '' : String(v);
  });
  const first = values[0] ?? '';
  return values.some((v) => v !== first)
    ? { value: '', raw: '', mixed: true }
    : { value: first, raw: first, mixed: false };
}

/** Same, but the switch's wording is mapped onto the CLI value we send. */
function commonMapped(items, pick, normalise) {
  const cur = common(items, pick);
  return { ...cur, value: cur.mixed ? '' : normalise(cur.raw) };
}

const normSpeed = (mode) => {
  const m = String(mode || '').trim().toLowerCase();
  if (m === 'auto') return 'auto';
  let hit = m.match(/^auto[-\s]?(10|100|1000)$/);
  if (hit) return `auto-${hit[1]}`;
  hit = m.match(/^(10|100|1000)\s*(fdx|hdx|full|half)$/);
  if (hit) return `${hit[1]}-${hit[2].startsWith('f') ? 'full' : 'half'}`;
  return '';
};

const normFlow = (value) => {
  const v = String(value || '').trim().toLowerCase();
  if (['enable', 'enabled', 'on', 'yes'].includes(v)) return '1';
  if (['disable', 'disabled', 'off', 'no'].includes(v)) return '0';
  return '';
};

const normMdi = (value) => {
  const v = String(value || '').trim().toLowerCase().replace(/[-_\s]/g, '');
  if (v === 'auto' || v === 'automdix') return 'auto-mdix';
  if (v === 'mdi') return 'mdi';
  if (v === 'mdix') return 'mdix';
  return '';
};

/**
 * A select that opens on the current setting.
 * `options` are the real settings; the "unverändert" entry is only added when
 * there is nothing sensible to select — a mixed selection, or a value this
 * firmware spells in a way we do not recognise.
 */
function stateSelect(options, current, props = {}) {
  const known = !current.mixed && options.some(([value]) => value === current.value);
  const head = known
    ? []
    : [['', current.mixed
      ? '— gemischt, unverändert —'
      : (current.raw ? `${current.raw} — unverändert` : '— unverändert —')]];
  const baseline = known ? current.value : '';
  const el = select([...head, ...options], { ...props, value: baseline });
  return { el, baseline, changed: () => el.value !== baseline };
}

function stateCheck(labelText, current) {
  const baseline = current.mixed ? false : current.value === 'true';
  const box = checkbox(labelText + (current.mixed ? ' (gemischt)' : ''), baseline);
  // `indeterminate` is a property, not an attribute — it cannot be set via h().
  if (current.mixed) box.input.indeterminate = true;
  return { ...box, baseline, changed: () => box.input.checked !== baseline };
}

function buildInspector(chosen, vlans, allPorts, refresh) {
  const ids = chosen.map((p) => p.port);
  const nodes = [];

  nodes.push(h('div.chip', { text: `${ids.length} Port(s): ${compact(chosen)}` }));

  // -- what the switch reports right now ----------------------------------
  if (chosen.length === 1) {
    const p = chosen[0];
    nodes.push(kv([
      ['Status', p.enabled === false
        ? 'administrativ deaktiviert'
        : (p.up ? `up · ${p.mode || ''}`.trim() : 'down')],
      ['Typ', p.type],
      ['Untagged', p.untagged ? `VLAN ${p.untagged}` : 'keines'],
      ['Tagged', (p.tagged || []).join(', ') || 'keine'],
      ['Trunk', p.trunk ? p.trunk.group : ''],
      ['Nachbar', p.lldp ? (p.lldp.system_name || p.lldp.chassis_id) : ''],
    ]));
  } else {
    const upCount = chosen.filter((p) => p.up).length;
    const offCount = chosen.filter((p) => p.enabled === false).length;
    nodes.push(h('p.note', {
      text: `${upCount} up, ${chosen.length - upCount} down`
        + (offCount ? `, ${offCount} deaktiviert` : '')
        + '. Felder mit „gemischt“ unterscheiden sich innerhalb der Auswahl.',
    }));
  }

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
  const curName = common(chosen, (p) => p.name || '');
  const nameInput = input({
    placeholder: curName.mixed ? 'gemischt — leer lässt alle unverändert' : 'Portname',
    value: curName.mixed ? '' : curName.value,
  });

  const speed = stateSelect([
    ['auto', 'auto'], ['auto-10', 'auto-10'], ['auto-100', 'auto-100'],
    ['auto-1000', 'auto-1000'], ['10-half', '10 half'], ['10-full', '10 full'],
    ['100-half', '100 half'], ['100-full', '100 full'], ['1000-full', '1000 full'],
  ], commonMapped(chosen, (p) => p.config?.mode, normSpeed));

  const flow = stateSelect(
    [['1', 'ein'], ['0', 'aus']],
    commonMapped(chosen, (p) => p.config?.flow_ctrl, normFlow),
  );

  const mdi = stateSelect(
    [['auto-mdix', 'auto-mdix'], ['mdi', 'mdi'], ['mdix', 'mdix']],
    commonMapped(chosen, (p) => p.config?.mdi, normMdi),
  );

  const lldp = stateSelect([
    ['tx_rx', 'tx + rx'], ['tx_only', 'nur tx'], ['rx_only', 'nur rx'], ['disable', 'aus'],
  ], common(chosen, (p) => p.lldp_admin));

  const curBcast = common(chosen, (p) => p.bcast_limit);
  const bcastInput = input({
    type: 'number', min: 0, max: 99,
    value: curBcast.mixed ? '' : (curBcast.value || ''),
    placeholder: curBcast.mixed ? 'gemischt' : 'unverändert',
  });
  const bcastBase = curBcast.mixed ? '' : (curBcast.value || '');

  nodes.push(field('Portname', nameInput, '(leer = Name entfernen)'));
  nodes.push(field('Speed / Duplex', speed.el));
  nodes.push(field('Flow Control', flow.el));
  nodes.push(field('MDI-Modus', mdi.el));
  nodes.push(field('LLDP', lldp.el));
  nodes.push(field('Broadcast-Limit', bcastInput, '% (0 = aus)'));

  nodes.push(h('div.form-actions', null,
    h('button.btn.btn-primary', {
      text: 'Porteinstellungen übernehmen',
      onclick: () => {
        const payload = { ports: ids };
        // A mixed name field only counts once something was typed into it.
        const nameBase = curName.mixed ? '' : curName.value;
        if (nameInput.value !== nameBase && !(curName.mixed && nameInput.value === '')) {
          payload.name = nameInput.value;
        }
        if (speed.changed() && speed.el.value) payload.speed_duplex = speed.el.value;
        if (flow.changed() && flow.el.value) payload.flow_control = flow.el.value === '1';
        if (mdi.changed() && mdi.el.value) payload.mdix_mode = mdi.el.value;
        if (lldp.changed() && lldp.el.value) payload.lldp_admin = lldp.el.value;
        if (bcastInput.value !== bcastBase && bcastInput.value !== '') {
          payload.broadcast_limit = Number(bcastInput.value);
        }
        if (Object.keys(payload).length === 1) { toast('Nichts geändert.', 'info'); return; }
        propose('port.settings', payload).then((ok) => ok && refresh());
      },
    }),
  ));

  // -- VLAN membership -----------------------------------------------------
  const vlanChoices = vlans.map((v) => [String(v.id), `${v.id} · ${v.name}`]);
  const vlanOptions = [['', '— nicht ändern —'], ...vlanChoices];
  const untagged = stateSelect(vlanChoices, common(chosen, (p) => p.untagged));
  const taggedAdd = select(vlanOptions);
  const taggedDel = select(vlanOptions);

  // Tagged VLANs are a set per port, so there is no single "current" value to
  // preselect — the two pickers stay add/remove actions. What the ports have
  // right now is listed above instead.
  const taggedNow = [...new Set(chosen.flatMap((p) => p.tagged || []))].sort((a, b) => a - b);

  nodes.push(h('hr', { style: { border: 'none', borderTop: '1px solid var(--line-soft)', margin: '4px 0' } }));
  nodes.push(h('h4', { text: 'VLAN-Zuordnung', style: { fontSize: '12px', color: 'var(--fg-dim)' } }));
  nodes.push(field('Untagged (Access-VLAN)', untagged.el));
  if (taggedNow.length) {
    nodes.push(h('p.note', { text: `Aktuell tagged: ${taggedNow.join(', ')}` }));
  }
  nodes.push(field('Tagged hinzufügen', taggedAdd));
  nodes.push(field('Tagged entfernen', taggedDel));
  nodes.push(h('div.form-actions', null,
    h('button.btn.btn-primary', {
      text: 'VLANs übernehmen',
      onclick: () => {
        const payload = { ports: ids };
        const untaggedSel = untagged.el;
        if (untagged.changed() && untaggedSel.value) {
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
  const edge = stateCheck('Admin-Edge-Port (PortFast)', common(chosen, (p) => !!p.stp?.admin_edge));
  const bpdu = stateCheck('BPDU-Protection', common(chosen, (p) => !!p.stp?.bpdu_protection));
  const rootGuard = stateCheck('Root-Guard', common(chosen, (p) => !!p.stp?.root_guard));
  const curCost = common(chosen, (p) => p.stp?.path_cost);
  // "Auto" is how the switch prints an unset cost; keep the box empty for it
  // so an unchanged port never produces a `spanning-tree ... path-cost` line.
  const costBase = curCost.mixed || /auto/i.test(curCost.value) ? '' : curCost.value;
  const costInput = input({
    type: 'number',
    value: costBase,
    placeholder: curCost.mixed ? 'gemischt' : 'auto',
  });

  nodes.push(h('hr', { style: { border: 'none', borderTop: '1px solid var(--line-soft)', margin: '4px 0' } }));
  nodes.push(h('h4', { text: 'Spanning Tree', style: { fontSize: '12px', color: 'var(--fg-dim)' } }));
  nodes.push(edge.el, bpdu.el, rootGuard.el, field('Pfadkosten', costInput, '(leer = auto)'));
  nodes.push(h('div.form-actions', null,
    h('button.btn.btn-sm', {
      text: 'STP übernehmen',
      onclick: () => {
        const payload = { ports: ids };
        if (edge.changed()) payload.admin_edge = edge.input.checked;
        if (bpdu.changed()) payload.bpdu_protection = bpdu.input.checked;
        if (rootGuard.changed()) payload.root_guard = rootGuard.input.checked;
        if (costInput.value !== costBase && costInput.value !== '') {
          payload.path_cost = Number(costInput.value);
        }
        if (Object.keys(payload).length === 1) { toast('Nichts geändert.', 'info'); return; }
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
