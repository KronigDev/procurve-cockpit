// The switch faceplate: ports laid out the way they sit on the front panel
// (odd on top, even below), so clicking port 13 in the UI matches the cable
// you are looking at.

import { h } from './ui.js';

const VLAN_COLORS = [
  '#22d3ee', '#a78bfa', '#34d399', '#fbbf24', '#f87171',
  '#60a5fa', '#f472b6', '#4ade80', '#fb923c', '#818cf8',
];

export function vlanColor(vid) {
  if (!vid) return '#2a3546';
  return VLAN_COLORS[Number(vid) % VLAN_COLORS.length];
}

/**
 * @param ports   merged port objects from /api/data/ports
 * @param opts    {selected:Set, colorBy, onToggle(port, ev), onHover}
 */
export function faceplate(ports, opts = {}) {
  const selected = opts.selected || new Set();
  const colorBy = opts.colorBy || 'status';

  const banks = groupIntoBanks(ports);
  const wrap = h('div.faceplate');

  for (const bank of banks) {
    const rows = h('div.fp-rows');
    for (const port of bank.ports) {
      rows.appendChild(portTile(port, selected, colorBy, opts));
    }
    wrap.appendChild(h('div.fp-bank', null,
      h('div.fp-bank-label', { text: bank.label }),
      rows,
    ));
  }
  return wrap;
}

function portTile(port, selected, colorBy, opts) {
  const classes = ['fp-port'];
  if (port.up) classes.push('up'); else classes.push('down');
  if (port.enabled === false) classes.push('disabled');
  if (selected.has(port.port)) classes.push('sel');
  if (port.trunk) classes.push('trunked');
  if (port.poe && port.poe.enabled) classes.push('poe');

  const tile = h('div', {
    class: classes.join(' '),
    title: tooltip(port),
    onclick: (ev) => opts.onToggle && opts.onToggle(port, ev),
  },
    h('span.fp-num', { text: port.port }),
    h('span.fp-led'),
  );

  const led = tile.querySelector('.fp-led');
  if (colorBy === 'vlan') {
    led.style.background = port.untagged ? vlanColor(port.untagged) : '#2a3546';
    led.style.boxShadow = port.untagged ? `0 0 6px ${vlanColor(port.untagged)}88` : 'none';
  } else if (colorBy === 'speed') {
    const mode = (port.mode || '').toLowerCase();
    const color = !port.up ? '#2a3546'
      : mode.includes('1000') ? '#34d399'
      : mode.includes('100') ? '#fbbf24'
      : mode.includes('10gig') || mode.includes('10000') ? '#22d3ee'
      : '#f87171';
    led.style.background = color;
    led.style.boxShadow = port.up ? `0 0 6px ${color}88` : 'none';
  } else if (colorBy === 'poe') {
    const poe = port.poe;
    const delivering = poe && parseFloat(poe.actual || '0') > 0;
    const color = !poe ? '#1c2534' : delivering ? '#fbbf24' : poe.enabled ? '#2a4a5a' : '#3a2020';
    led.style.background = color;
    led.style.boxShadow = delivering ? '0 0 6px #fbbf2488' : 'none';
  }
  return tile;
}

function tooltip(port) {
  const lines = [`Port ${port.port}${port.name ? ` — ${port.name}` : ''}`];
  lines.push(`${port.up ? 'Up' : 'Down'}${port.enabled === false ? ' (administrativ deaktiviert)' : ''}`);
  if (port.type) lines.push(`Typ: ${port.type}`);
  if (port.mode) lines.push(`Mode: ${port.mode}`);
  if (port.untagged) lines.push(`Untagged: VLAN ${port.untagged}`);
  if (port.tagged && port.tagged.length) lines.push(`Tagged: ${port.tagged.join(', ')}`);
  if (port.trunk) lines.push(`Trunk: ${port.trunk.group}`);
  if (port.poe) lines.push(`PoE: ${port.poe.enabled ? 'aktiv' : 'aus'} ${port.poe.actual || ''}`);
  if (port.lldp) lines.push(`LLDP: ${port.lldp.system_name || port.lldp.chassis_id} / ${port.lldp.port_id}`);
  return lines.join('\n');
}

/**
 * Split ports into visual banks: the numeric front panel first, then each
 * module (A1, B1 …) as its own group. Trunk pseudo-ports are never shown here.
 */
function groupIntoBanks(ports) {
  const numeric = [];
  const modules = new Map();
  for (const port of ports) {
    const id = String(port.port);
    if (/^\d+$/.test(id)) { numeric.push(port); continue; }
    if (/^trk/i.test(id)) continue;
    const key = id[0].toUpperCase();
    if (!modules.has(key)) modules.set(key, []);
    modules.get(key).push(port);
  }
  numeric.sort((a, b) => Number(a.port) - Number(b.port));

  const banks = [];
  if (numeric.length) banks.push({ label: `Ports 1–${numeric[numeric.length - 1].port}`, ports: numeric });
  for (const [key, list] of [...modules.entries()].sort()) {
    list.sort((a, b) => String(a.port).localeCompare(String(b.port), undefined, { numeric: true }));
    banks.push({ label: `Modul ${key}`, ports: list });
  }
  return banks;
}

export function legend(colorBy) {
  const entries = {
    status: [['#34d399', 'Link up'], ['#2a3546', 'Link down'], ['#f87171', 'deaktiviert'], ['#a78bfa', 'Trunk-Mitglied']],
    vlan: [['#22d3ee', 'untagged VLAN (Farbe = VLAN-ID)'], ['#2a3546', 'keine untagged Zuordnung']],
    speed: [['#34d399', '1 Gbit'], ['#fbbf24', '100 Mbit'], ['#22d3ee', '10 Gbit'], ['#2a3546', 'kein Link']],
    poe: [['#fbbf24', 'liefert Strom'], ['#2a4a5a', 'PoE aktiv, kein Verbraucher'], ['#3a2020', 'PoE aus']],
  }[colorBy] || [];
  return h('div.fp-legend', null, entries.map(([color, label]) =>
    h('span', null, h('i', { style: { background: color } }), label)));
}

/** Shift-click range selection against the last clicked port. */
export function applySelection(selected, ports, port, ev, lastRef) {
  const id = port.port;
  if (ev.shiftKey && lastRef.value) {
    const ids = ports.map((p) => p.port);
    const from = ids.indexOf(lastRef.value);
    const to = ids.indexOf(id);
    if (from !== -1 && to !== -1) {
      const [lo, hi] = from < to ? [from, to] : [to, from];
      for (let i = lo; i <= hi; i += 1) selected.add(ids[i]);
      return;
    }
  }
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  lastRef.value = id;
}
