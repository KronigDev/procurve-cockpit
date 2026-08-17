// Port management: pick ports on the faceplate (or in the table), then act on
// the whole selection at once. Every action goes through the change preview.

import { api } from '../api.js';
import { propose } from '../changes.js';
import { applySelection, faceplate, legend } from '../faceplate.js';
import {
  badge, card, checkbox, field, h, input, kv, loading, rawBlock, segmented, select,
  structured, table, toast,
} from '../ui.js';

const selected = new Set();
const lastClicked = { value: null };
let colorBy = 'status';
let filterText = '';

/** Hex digits only, so every MAC notation compares equal. */
export const normMac = (mac) => String(mac || '').toLowerCase().replace(/[^0-9a-f]/g, '');

/**
 * Everything about a port that the search box should match, including the
 * shorthand the table prints: typing `U100` has to find the port whose
 * untagged VLAN is 100, even though the raw field just says `100`. The MACs
 * learned behind the port are in here too — pasting a MAC in any notation
 * finds the port it hangs on.
 */
function haystack(p) {
  return [
    p.port, p.name, p.type, p.mode, p.status, p.flow_control,
    p.enabled === false ? 'disabled' : 'enabled',
    p.up ? 'up' : 'down',
    p.untagged ? `u${p.untagged} untagged ${p.untagged} vlan${p.untagged}` : '',
    ...(p.tagged || []).map((v) => `t${v} tagged ${v} vlan${v}`),
    p.trunk?.group, p.lldp?.system_name, p.lldp?.chassis_id,
    p.config?.mode, p.lldp_admin, p.poe?.status,
    ...(p.macs || []).flatMap((m) => [m.mac, normMac(m.mac), m.ip]),
  ].filter(Boolean).join(' ').toLowerCase();
}

export default {
  id: 'ports',
  title: 'Ports',
  icon: '▦',
  group: 'Configuration',

  async render(root, ctx) {
    const [{ data: portData }, { data: vlanData }, { data: fwd }] = await Promise.all([
      api.data('ports'),
      api.data('vlans'),
      api.data('forwarding'),
    ]);
    const ports = portData.ports || [];
    const vlans = vlanData.vlans || [];

    // Which MACs sit behind which port. `show mac-address` already lists the
    // whole table, so this costs nothing extra beyond the one command, and the
    // ARP table turns each MAC into an IP where one is known.
    const ipByMac = new Map((fwd.arp.data || []).map((a) => [normMac(a.mac), a.ip]));
    const macsByPort = new Map();
    for (const entry of fwd.mac.data || []) {
      if (!macsByPort.has(entry.port)) macsByPort.set(entry.port, []);
      macsByPort.get(entry.port).push({
        mac: entry.mac,
        vlan: entry.vlan || '',
        ip: ipByMac.get(normMac(entry.mac)) || '',
      });
    }
    for (const p of ports) {
      p.macs = macsByPort.get(p.port) || [];
      p._hay = haystack(p);
    }

    // Drop selections for ports that no longer exist (module pulled, etc.).
    for (const id of [...selected]) {
      if (!ports.some((p) => p.port === id)) selected.delete(id);
    }

    const refresh = () => ctx.reload();
    // Re-colouring is purely visual — assigned once the drawing helpers below
    // exist, so switching the colour mode never re-queries the switch.
    let recolour = () => {};
    // Assigned below; declared here so the toolbar can call them.
    let redraw = () => {};

    const COLOR_MODES = [['status', 'Status'], ['vlan', 'VLAN'], ['speed', 'Speed'], ['poe', 'PoE']];
    const colorSeg = segmented(COLOR_MODES, colorBy, (value) => { colorBy = value; recolour(); });

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'Ports' }),
      h('p', { text: `${ports.length} ports · ${ports.filter((p) => p.up).length} up` }),
      h('span.spacer'),
      h('div.fp-colorby', null,
        h('span.muted', { text: 'Colour by' }),
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
            redraw();
          },
        }),
        legend(colorBy),
      );
    };

    recolour = () => {
      drawFaceplate();
      for (const [index, button] of [...colorSeg.querySelectorAll('button')].entries()) {
        button.classList.toggle('on', COLOR_MODES[index][0] === colorBy);
      }
    };

    // ── selection toolbar ──────────────────────────────────────────────
    const setSelection = (list) => {
      selected.clear();
      for (const p of list) selected.add(p.port);
      redraw();
    };
    const visible = () => {
      const needle = filterText.trim().toLowerCase();
      return needle ? ports.filter((p) => p._hay.includes(needle)) : ports;
    };

    const selectionTools = h('div.toolbar', null,
      h('button.btn.btn-sm', { text: 'Select all', onclick: () => setSelection(ports) }),
      h('button.btn.btn-sm', { text: 'Clear selection', onclick: () => setSelection([]) }),
      h('button.btn.btn-sm', {
        text: 'Invert',
        onclick: () => setSelection(ports.filter((p) => !selected.has(p.port))),
      }),
      h('span.dim', { text: '│' }),
      h('button.btn.btn-sm', { text: 'Only up', onclick: () => setSelection(ports.filter((p) => p.up)) }),
      h('button.btn.btn-sm', { text: 'Only down', onclick: () => setSelection(ports.filter((p) => !p.up)) }),
      h('button.btn.btn-sm', {
        text: 'Only disabled',
        onclick: () => setSelection(ports.filter((p) => p.enabled === false)),
      }),
      h('span.spacer'),
      h('span.sel-summary', { id: 'sel-summary', text: '' }),
    );

    // ── inspector ──────────────────────────────────────────────────────
    const inspector = h('div.card.inspector', null,
      h('header', null, h('h3', { text: 'Edit selection' })),
      h('div.card-body', { id: 'insp-body' }),
    );

    const drawInspector = () => {
      const body = inspector.querySelector('#insp-body');
      const summary = selectionTools.querySelector('#sel-summary');
      const chosen = ports.filter((p) => selected.has(p.port));
      summary.textContent = chosen.length ? `${chosen.length} selected: ${compact(chosen)}` : '';

      if (!chosen.length) {
        body.replaceChildren(h('p.note', {
          text: 'Click ports on the faceplate. Shift-click selects a range.',
        }));
        return;
      }
      body.replaceChildren(...buildInspector(chosen, vlans, ports, refresh));
    };

    // ── table ──────────────────────────────────────────────────────────
    const tableHost = h('div');
    const markTable = () => {
      for (const tr of tableHost.querySelectorAll('tr[data-port]')) {
        tr.classList.toggle('sel', selected.has(tr.dataset.port));
      }
      const box = tableHost.querySelector('#tbl-all');
      if (box) {
        const rows = visible();
        const hits = rows.filter((p) => selected.has(p.port)).length;
        box.checked = rows.length > 0 && hits === rows.length;
        box.indeterminate = hits > 0 && hits < rows.length;
      }
    };

    const drawTable = () => {
      const rows = visible();
      // Header checkbox acts on what is currently filtered, not on all ports —
      // otherwise a filtered view would silently select things you cannot see.
      const allBox = h('input', {
        type: 'checkbox',
        title: 'Select/clear everything currently listed',
        onclick: (ev) => {
          const target = ev.target.checked;
          for (const p of rows) {
            if (target) selected.add(p.port); else selected.delete(p.port);
          }
          redraw();
        },
        id: 'tbl-all',
      });

      const node = table([
        { key: 'sel', label: allBox, render: () => '' },
        { key: 'port', label: 'Port', mono: true },
        { key: 'name', label: 'Name' },
        { key: 'type', label: 'Type' },
        {
          key: 'status',
          label: 'Status',
          render: (p) => p.enabled === false
            ? badge('disabled', 'danger')
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
        {
          key: 'macs',
          label: 'MACs',
          num: true,
          render: (p) => p.macs.length
            ? h('span', { title: p.macs.map((m) => m.mac).join('\n'), text: String(p.macs.length) })
            : '',
        },
        { key: 'trunk', label: 'Trunk', render: (p) => p.trunk ? badge(p.trunk.group, 'violet') : '' },
        {
          key: 'lldp',
          label: 'Neighbour (LLDP)',
          render: (p) => p.lldp ? (p.lldp.system_name || p.lldp.chassis_id) : '',
        },
        { key: 'flow_control', label: 'Flow' },
      ], rows, {
        emptyText: filterText ? `No port matches “${filterText}”.` : 'No ports reported.',
        onRow: (p) => {
          if (selected.has(p.port)) selected.delete(p.port); else selected.add(p.port);
          lastClicked.value = p.port;
          redraw();
        },
      });
      for (const [index, tr] of [...node.querySelectorAll('tbody tr')].entries()) {
        tr.dataset.port = rows[index].port;
      }
      tableHost.replaceChildren(node);
    };

    const search = input({
      type: 'search',
      placeholder: 'Filter: name, U100, T20, up, disabled, neighbour …',
      value: filterText,
      oninput: (ev) => { filterText = ev.target.value; drawTable(); markTable(); },
    });
    const searchBar = h('div.toolbar', null,
      search,
      h('button.btn.btn-sm', {
        text: 'Select listed',
        title: 'Select every port the filter currently shows',
        onclick: () => setSelection(visible()),
      }),
      h('span.spacer'),
      h('span.dim', { id: 'filter-count' }),
    );

    redraw = () => {
      drawFaceplate();
      drawInspector();
      drawTable();
      markTable();
      const count = searchBar.querySelector('#filter-count');
      const rows = visible();
      count.textContent = rows.length === ports.length
        ? `${ports.length} ports`
        : `${rows.length} of ${ports.length} ports`;
    };
    redraw();

    root.appendChild(card(null, null, [fpWrap, selectionTools], null));
    root.appendChild(h('div.split', null,
      h('div', null,
        card('Port list', null, [
          searchBar,
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
// "unchanged". The catch: preselecting must not turn into a change. So each
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
 * `options` are the real settings; the "unchanged" entry is only added when
 * there is nothing sensible to select — a mixed selection, or a value this
 * firmware spells in a way we do not recognise.
 */
function stateSelect(options, current, props = {}) {
  const known = !current.mixed && options.some(([value]) => value === current.value);
  const head = known
    ? []
    : [['', current.mixed
      ? '— mixed, keep as is —'
      : (current.raw ? `${current.raw} (as reported)` : '— keep as is —')]];
  const baseline = known ? current.value : '';
  const el = select([...head, ...options], { ...props, value: baseline });
  return { el, baseline, changed: () => el.value !== baseline };
}

function stateCheck(labelText, current) {
  const baseline = current.mixed ? false : current.value === 'true';
  const box = checkbox(labelText + (current.mixed ? ' (mixed)' : ''), baseline);
  // `indeterminate` is a property, not an attribute — it cannot be set via h().
  if (current.mixed) box.input.indeterminate = true;
  return { ...box, baseline, changed: () => box.input.checked !== baseline };
}

function buildInspector(chosen, vlans, allPorts, refresh) {
  const ids = chosen.map((p) => p.port);
  const nodes = [];

  nodes.push(h('div.chip', { text: `${ids.length} port(s): ${compact(chosen)}` }));

  // -- what the switch reports right now ----------------------------------
  if (chosen.length === 1) {
    const p = chosen[0];
    nodes.push(kv([
      ['Status', p.enabled === false
        ? 'administratively disabled'
        : (p.up ? `up · ${p.mode || ''}`.trim() : 'down')],
      ['Type', p.type],
      ['Untagged', p.untagged ? `VLAN ${p.untagged}` : 'none'],
      ['Tagged', (p.tagged || []).join(', ') || 'none'],
      ['Trunk', p.trunk ? p.trunk.group : ''],
      ['Neighbour', p.lldp ? (p.lldp.system_name || p.lldp.chassis_id) : ''],
    ]));
  } else {
    const upCount = chosen.filter((p) => p.up).length;
    const offCount = chosen.filter((p) => p.enabled === false).length;
    nodes.push(h('p.note', {
      text: `${upCount} up, ${chosen.length - upCount} down`
        + (offCount ? `, ${offCount} disabled` : '')
        + '. Fields marked “mixed” differ within the selection.',
    }));
  }

  // -- per-port statistics (single port only) ------------------------------
  if (chosen.length === 1) {
    const statsHost = h('div');
    const loadStats = async () => {
      statsHost.replaceChildren(loading('Loading statistics …'));
      try {
        const [counters, rmon] = await Promise.all([
          api.showCmd(`show interfaces ${ids[0]}`, 30),
          api.showCmd(`show rmon statistics ${ids[0]}`, 30).catch(() => null),
        ]);
        statsHost.replaceChildren(
          structured(counters),
          rmon && !rmon.error && (rmon.raw || '').trim() ? structured(rmon) : null,
        );
      } catch (err) {
        statsHost.replaceChildren(h('p.note', { text: `Statistics failed: ${err.message}` }));
      }
    };
    nodes.push(h('div.form-actions', null,
      h('button.btn.btn-sm', {
        text: `Load statistics for port ${ids[0]}`,
        title: `show interfaces ${ids[0]} + show rmon statistics ${ids[0]}`,
        onclick: loadStats,
      }),
    ));
    nodes.push(statsHost);
  }

  // -- quick enable/disable ------------------------------------------------
  // Only the button that would change something. Offering "Enable" on a port
  // that is already enabled invites a plan that does nothing.
  const anyEnabled = chosen.some((p) => p.enabled !== false);
  const anyDisabled = chosen.some((p) => p.enabled === false);
  nodes.push(h('div.form-actions', null,
    anyDisabled ? h('button.btn.btn-sm', {
      text: anyEnabled ? `Enable (${chosen.filter((p) => p.enabled === false).length} disabled)` : 'Enable',
      onclick: () => propose('port.settings', { ports: ids, enabled: true }).then((ok) => ok && refresh()),
    }) : null,
    anyEnabled ? h('button.btn.btn-sm', {
      text: anyDisabled ? `Disable (${chosen.filter((p) => p.enabled !== false).length} enabled)` : 'Disable',
      onclick: () => propose('port.settings', { ports: ids, enabled: false }).then((ok) => ok && refresh()),
    }) : null,
  ));

  // -- MACs learned behind the selection ------------------------------------
  const macs = chosen.flatMap((p) => (p.macs || []).map((m) => ({ ...m, port: p.port })));
  if (macs.length) {
    const macHost = h('div.mac-list');
    const macSearch = input({
      type: 'search',
      placeholder: 'Filter MAC / IP …',
      oninput: (ev) => drawMacs(ev.target.value.trim().toLowerCase()),
    });
    const drawMacs = (needle = '') => {
      const hits = needle
        ? macs.filter((m) => `${m.mac} ${normMac(m.mac)} ${m.ip} ${m.vlan}`.toLowerCase().includes(needle))
        : macs;
      macHost.replaceChildren(...hits.slice(0, 200).map((m) => h('div.mac-row', null,
        h('span.mono', { text: m.mac }),
        m.ip ? h('span.dim', { text: m.ip }) : null,
        h('span.spacer'),
        chosen.length > 1 ? h('span.dim', { text: `port ${m.port}` }) : null,
        m.vlan ? badge(`V${m.vlan}`, 'mute') : null,
      )));
      if (!hits.length) macHost.replaceChildren(h('p.note', { text: 'No match.' }));
      else if (hits.length > 200) macHost.appendChild(h('p.note', { text: `… ${hits.length - 200} more` }));
    };
    drawMacs();

    nodes.push(h('hr', { style: { border: 'none', borderTop: '1px solid var(--line-soft)', margin: '4px 0' } }));
    nodes.push(h('h4', {
      text: `MAC addresses behind ${chosen.length === 1 ? `port ${ids[0]}` : 'the selection'} (${macs.length})`,
      style: { fontSize: '12px', color: 'var(--fg-dim)' },
    }));
    nodes.push(macSearch, macHost);
  }

  // -- name / speed / misc -------------------------------------------------
  const curName = common(chosen, (p) => p.name || '');
  const nameInput = input({
    placeholder: curName.mixed ? 'mixed — empty leaves all unchanged' : 'Port name',
    value: curName.mixed ? '' : curName.value,
  });

  const speed = stateSelect([
    ['auto', 'auto'], ['auto-10', 'auto-10'], ['auto-100', 'auto-100'],
    ['auto-1000', 'auto-1000'], ['10-half', '10 half'], ['10-full', '10 full'],
    ['100-half', '100 half'], ['100-full', '100 full'], ['1000-full', '1000 full'],
  ], commonMapped(chosen, (p) => p.config?.mode, normSpeed));

  const flow = stateSelect(
    [['1', 'on'], ['0', 'off']],
    commonMapped(chosen, (p) => p.config?.flow_ctrl, normFlow),
  );

  const mdi = stateSelect(
    [['auto-mdix', 'auto-mdix'], ['mdi', 'mdi'], ['mdix', 'mdix']],
    commonMapped(chosen, (p) => p.config?.mdi, normMdi),
  );

  const lldp = stateSelect([
    ['tx_rx', 'tx + rx'], ['tx_only', 'tx only'], ['rx_only', 'rx only'], ['disable', 'off'],
  ], common(chosen, (p) => p.lldp_admin));

  const curBcast = common(chosen, (p) => p.bcast_limit);
  const bcastInput = input({
    type: 'number', min: 0, max: 99,
    value: curBcast.mixed ? '' : (curBcast.value || ''),
    placeholder: curBcast.mixed ? 'mixed' : 'not set',
  });
  const bcastBase = curBcast.mixed ? '' : (curBcast.value || '');

  nodes.push(field('Port name', nameInput, '(empty removes the name)'));
  nodes.push(field('Speed / duplex', speed.el));
  nodes.push(field('Flow control', flow.el));
  nodes.push(field('MDI mode', mdi.el));
  nodes.push(field('LLDP', lldp.el));
  nodes.push(field('Broadcast limit', bcastInput, '% (0 = off)'));

  nodes.push(h('div.form-actions', null,
    h('button.btn.btn-primary', {
      text: 'Apply port settings',
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
        if (Object.keys(payload).length === 1) { toast('Nothing changed.', 'info'); return; }
        propose('port.settings', payload).then((ok) => ok && refresh());
      },
    }),
  ));

  // -- VLAN membership -----------------------------------------------------
  const vlanChoices = vlans.map((v) => [String(v.id), `${v.id} · ${v.name}`]);
  const vlanOptions = [['', '— no change —'], ...vlanChoices];
  const untagged = stateSelect(vlanChoices, common(chosen, (p) => p.untagged));
  const taggedAdd = select(vlanOptions);
  const taggedDel = select(vlanOptions);

  // Tagged VLANs are a set per port, so there is no single "current" value to
  // preselect — the two pickers stay add/remove actions. What the ports have
  // right now is listed above instead.
  const taggedNow = [...new Set(chosen.flatMap((p) => p.tagged || []))].sort((a, b) => a - b);

  nodes.push(h('hr', { style: { border: 'none', borderTop: '1px solid var(--line-soft)', margin: '4px 0' } }));
  nodes.push(h('h4', { text: 'VLAN membership', style: { fontSize: '12px', color: 'var(--fg-dim)' } }));
  nodes.push(field('Untagged (access VLAN)', untagged.el));
  if (taggedNow.length) {
    nodes.push(h('p.note', { text: `Currently tagged: ${taggedNow.join(', ')}` }));
  }
  nodes.push(field('Add tagged', taggedAdd));
  nodes.push(field('Remove tagged', taggedDel));
  nodes.push(h('div.form-actions', null,
    h('button.btn.btn-primary', {
      text: 'Apply VLANs',
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
        if (Object.keys(payload).length === 1) { toast('No VLAN selected.', 'info'); return; }
        propose('port.vlans', payload).then((ok) => ok && refresh());
      },
    }),
  ));

  // -- spanning tree per port ---------------------------------------------
  const edge = stateCheck('Admin edge port (PortFast)', common(chosen, (p) => !!p.stp?.admin_edge));
  const bpdu = stateCheck('BPDU protection', common(chosen, (p) => !!p.stp?.bpdu_protection));
  const rootGuard = stateCheck('Root guard', common(chosen, (p) => !!p.stp?.root_guard));
  const curCost = common(chosen, (p) => p.stp?.path_cost);
  // "Auto" is how the switch prints an unset cost; keep the box empty for it
  // so an unchanged port never produces a `spanning-tree ... path-cost` line.
  const costBase = curCost.mixed || /auto/i.test(curCost.value) ? '' : curCost.value;
  const costInput = input({
    type: 'number',
    value: costBase,
    placeholder: curCost.mixed ? 'mixed' : 'auto',
  });

  nodes.push(h('hr', { style: { border: 'none', borderTop: '1px solid var(--line-soft)', margin: '4px 0' } }));
  nodes.push(h('h4', { text: 'Spanning tree', style: { fontSize: '12px', color: 'var(--fg-dim)' } }));
  nodes.push(edge.el, bpdu.el, rootGuard.el, field('Path cost', costInput, '(empty = auto)'));
  nodes.push(h('div.form-actions', null,
    h('button.btn.btn-sm', {
      text: 'Apply STP',
      onclick: () => {
        const payload = { ports: ids };
        if (edge.changed()) payload.admin_edge = edge.input.checked;
        if (bpdu.changed()) payload.bpdu_protection = bpdu.input.checked;
        if (rootGuard.changed()) payload.root_guard = rootGuard.input.checked;
        if (costInput.value !== costBase && costInput.value !== '') {
          payload.path_cost = Number(costInput.value);
        }
        if (Object.keys(payload).length === 1) { toast('Nothing changed.', 'info'); return; }
        propose('stp.port', payload).then((ok) => ok && refresh());
      },
    }),
    h('button.btn.btn-sm', {
      text: 'Remove edge/guard',
      onclick: () => propose('stp.port', {
        ports: ids, admin_edge: false, bpdu_protection: false, root_guard: false,
      }).then((ok) => ok && refresh()),
    }),
  ));

  return nodes;
}
