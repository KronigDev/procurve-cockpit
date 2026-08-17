// What the switch sees: LLDP/CDP neighbours, the MAC and ARP tables, and
// layer-3 configuration.

import { api } from '../api.js';
import { propose } from '../changes.js';
import {
  badge, card, field, h, input, rawBlock, rawCard, table, toast,
} from '../ui.js';

const neighbors = {
  id: 'neighbors',
  title: 'Neighbours',
  icon: '⇋',
  group: 'Diagnostics',

  async render(root) {
    const { data } = await api.data('neighbors');
    const list = data.lldp.data || [];

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'Neighbouring devices' }),
      h('p', { text: `${list.length} reported via LLDP` }),
    ));

    root.appendChild(card('LLDP', data.lldp.command, [
      table([
        { key: 'port', label: 'Local port', mono: true },
        { key: 'system_name', label: 'Device' },
        { key: 'chassis_id', label: 'Chassis id', mono: true },
        { key: 'port_id', label: 'Remote port', mono: true },
        { key: 'port_descr', label: 'Description' },
      ], list),
      rawBlock(data.lldp),
    ], null, true));

    root.appendChild(rawCard('LLDP detail', data.lldp_detail));
    root.appendChild(rawCard('CDP', data.cdp));
  },
};

const forwarding = {
  id: 'forwarding',
  title: 'MAC & ARP',
  icon: '≡',
  group: 'Diagnostics',

  async render(root) {
    const { data } = await api.data('forwarding');
    const macs = data.mac.data || [];
    const arps = data.arp.data || [];
    // Cross-reference: an ARP entry tells you which IP belongs to a MAC we saw.
    const ipByMac = new Map(arps.map((a) => [normMac(a.mac), a.ip]));

    let needle = '';
    const macHost = h('div');
    const drawMacs = () => {
      const rows = needle
        ? macs.filter((m) => `${m.mac} ${m.port} ${m.vlan} ${ipByMac.get(normMac(m.mac)) || ''}`
            .toLowerCase().includes(needle))
        : macs;
      macHost.replaceChildren(table([
        { key: 'mac', label: 'MAC', mono: true },
        { key: 'port', label: 'Port', mono: true },
        { key: 'vlan', label: 'VLAN', mono: true },
        { key: 'ip', label: 'IP (from ARP)', mono: true, render: (m) => ipByMac.get(normMac(m.mac)) || '' },
      ], rows));
    };
    drawMacs();

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'MAC & ARP tables' }),
      h('p', { text: `${macs.length} MAC entries · ${arps.length} ARP entries` }),
    ));

    root.appendChild(card('MAC address table', data.mac.command, [
      h('div.toolbar', null, input({
        type: 'search',
        placeholder: 'Search MAC, port, VLAN or IP …',
        oninput: (ev) => { needle = ev.target.value.trim().toLowerCase(); drawMacs(); },
      })),
      macHost,
      rawBlock(data.mac),
    ]));

    root.appendChild(card('ARP table', data.arp.command, [
      table([
        { key: 'ip', label: 'IP', mono: true },
        { key: 'mac', label: 'MAC', mono: true },
        { key: 'type', label: 'Type' },
        { key: 'port', label: 'Port', mono: true },
      ], arps),
      rawBlock(data.arp),
    ], null, true));
  },
};

const routing = {
  id: 'routing',
  title: 'IP & Routing',
  icon: '⇢',
  group: 'Configuration',

  async render(root, ctx) {
    const { data } = await api.data('routing');
    const refresh = () => ctx.reload();
    const ips = data.ip.data || [];
    const routes = data.routes.data || [];
    const routingOn = /ip routing\s*:\s*enabled/i.test(data.ip.raw)
      || routes.some((r) => /connected/i.test(r.type));

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'IP & Routing' }),
      h('p', { text: `${ips.length} VLAN interfaces · ${routes.length} routes` }),
    ));

    root.appendChild(card('IP addresses per VLAN', data.ip.command, [
      table([
        { key: 'vlan', label: 'VLAN', mono: true },
        { key: 'config', label: 'Mode' },
        { key: 'ip', label: 'Address', mono: true },
        { key: 'mask', label: 'Mask', mono: true },
      ], ips),
      rawBlock(data.ip),
    ], null, true));

    root.appendChild(card('Routing table', data.routes.command, [
      table([
        { key: 'destination', label: 'Destination', mono: true },
        { key: 'gateway', label: 'Gateway', mono: true },
        { key: 'vlan', label: 'VLAN', mono: true },
        {
          key: 'type',
          label: 'Type',
          render: (r) => badge(r.type || '—', /connect/i.test(r.type) ? 'ok' : 'mute'),
        },
        { key: 'metric', label: 'Metric', num: true },
        { key: 'distance', label: 'Distance', num: true },
      ], routes),
      rawBlock(data.routes),
    ], null, true));

    // -- editor -------------------------------------------------------------
    const destInput = input({ placeholder: '10.20.0.0/24' });
    const gwInput = input({ placeholder: '192.168.1.254' });
    const distInput = input({ type: 'number', placeholder: 'distance (optional)' });
    const defGwInput = input({ placeholder: '192.168.1.1' });

    root.appendChild(h('div.grid.cols-2', null,
      card('Static route', null, [
        field('Destination network (CIDR)', destInput),
        field('Gateway', gwInput),
        field('Administrative distance', distInput),
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Add route',
            onclick: () => {
              if (!destInput.value || !gwInput.value) { toast('Enter destination and gateway.', 'err'); return; }
              propose('routing.set', {
                add_routes: [{
                  destination: destInput.value,
                  gateway: gwInput.value,
                  distance: distInput.value ? Number(distInput.value) : undefined,
                }],
              }).then((ok) => ok && refresh());
            },
          }),
          h('button.btn', {
            text: 'Remove route',
            onclick: () => {
              if (!destInput.value || !gwInput.value) { toast('Enter destination and gateway.', 'err'); return; }
              propose('routing.set', {
                remove_routes: [{ destination: destInput.value, gateway: gwInput.value }],
              }).then((ok) => ok && refresh());
            },
          }),
        ),
      ]),
      card('Global routing', null, [
        h('p.note', { text: `IP routing is currently ${routingOn ? 'enabled' : 'probably disabled'}.` }),
        h('div.form-actions', null,
          h('button.btn', {
            text: 'Enable IP routing',
            onclick: () => propose('routing.set', { enabled: true }).then((ok) => ok && refresh()),
          }),
          h('button.btn', {
            text: 'Disable IP routing',
            onclick: () => propose('routing.set', { enabled: false }).then((ok) => ok && refresh()),
          }),
        ),
        field('Default gateway', defGwInput, '(only relevant without IP routing)'),
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Set default gateway',
            onclick: () => {
              if (!defGwInput.value) { toast('Enter a gateway.', 'err'); return; }
              propose('routing.set', { default_gateway: defGwInput.value }).then((ok) => ok && refresh());
            },
          }),
        ),
      ]),
    ));

    root.appendChild(rawCard('RIP', data.rip));
    root.appendChild(rawCard('DHCP helper addresses', data.helper));
  },
};

export default [neighbors, forwarding, routing];

function normMac(mac) {
  return String(mac || '').toLowerCase().replace(/[^0-9a-f]/g, '');
}
