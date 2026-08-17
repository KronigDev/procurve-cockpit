// What the switch sees: LLDP/CDP neighbours, the MAC and ARP tables, and
// layer-3 configuration.

import { api } from '../api.js';
import { propose } from '../changes.js';
import {
  badge, card, field, h, input, rawBlock, rawCard, table, toast,
} from '../ui.js';

const neighbors = {
  id: 'neighbors',
  title: 'Nachbarn',
  icon: '⇋',
  group: 'Diagnose',

  async render(root) {
    const { data } = await api.data('neighbors');
    const list = data.lldp.data || [];

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'Nachbargeräte' }),
      h('p', { text: `${list.length} über LLDP gemeldet` }),
    ));

    root.appendChild(card('LLDP', data.lldp.command, [
      table([
        { key: 'port', label: 'Lokaler Port', mono: true },
        { key: 'system_name', label: 'Gerät' },
        { key: 'chassis_id', label: 'Chassis-ID', mono: true },
        { key: 'port_id', label: 'Remote-Port', mono: true },
        { key: 'port_descr', label: 'Beschreibung' },
      ], list),
      rawBlock(data.lldp),
    ], null, true));

    root.appendChild(rawCard('LLDP Details', data.lldp_detail));
    root.appendChild(rawCard('CDP', data.cdp));
  },
};

const forwarding = {
  id: 'forwarding',
  title: 'MAC & ARP',
  icon: '≡',
  group: 'Diagnose',

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
        { key: 'ip', label: 'IP (aus ARP)', mono: true, render: (m) => ipByMac.get(normMac(m.mac)) || '' },
      ], rows));
    };
    drawMacs();

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'MAC- & ARP-Tabelle' }),
      h('p', { text: `${macs.length} MAC-Einträge · ${arps.length} ARP-Einträge` }),
    ));

    root.appendChild(card('MAC-Adresstabelle', data.mac.command, [
      h('div.toolbar', null, input({
        type: 'search',
        placeholder: 'MAC, Port, VLAN oder IP suchen …',
        oninput: (ev) => { needle = ev.target.value.trim().toLowerCase(); drawMacs(); },
      })),
      macHost,
      rawBlock(data.mac),
    ]));

    root.appendChild(card('ARP-Tabelle', data.arp.command, [
      table([
        { key: 'ip', label: 'IP', mono: true },
        { key: 'mac', label: 'MAC', mono: true },
        { key: 'type', label: 'Typ' },
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
  group: 'Konfiguration',

  async render(root, ctx) {
    const { data } = await api.data('routing');
    const refresh = () => ctx.reload();
    const ips = data.ip.data || [];
    const routes = data.routes.data || [];
    const routingOn = /ip routing\s*:\s*enabled/i.test(data.ip.raw)
      || routes.some((r) => /connected/i.test(r.type));

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'IP & Routing' }),
      h('p', { text: `${ips.length} VLAN-Interfaces · ${routes.length} Routen` }),
    ));

    root.appendChild(card('IP-Adressen pro VLAN', data.ip.command, [
      table([
        { key: 'vlan', label: 'VLAN', mono: true },
        { key: 'config', label: 'Modus' },
        { key: 'ip', label: 'Adresse', mono: true },
        { key: 'mask', label: 'Maske', mono: true },
      ], ips),
      rawBlock(data.ip),
    ], null, true));

    root.appendChild(card('Routing-Tabelle', data.routes.command, [
      table([
        { key: 'destination', label: 'Ziel', mono: true },
        { key: 'gateway', label: 'Gateway', mono: true },
        { key: 'vlan', label: 'VLAN', mono: true },
        {
          key: 'type',
          label: 'Typ',
          render: (r) => badge(r.type || '—', /connect/i.test(r.type) ? 'ok' : 'mute'),
        },
        { key: 'metric', label: 'Metrik', num: true },
        { key: 'distance', label: 'Distanz', num: true },
      ], routes),
      rawBlock(data.routes),
    ], null, true));

    // -- editor -------------------------------------------------------------
    const destInput = input({ placeholder: '10.20.0.0/24' });
    const gwInput = input({ placeholder: '192.168.1.254' });
    const distInput = input({ type: 'number', placeholder: 'Distanz (optional)' });
    const defGwInput = input({ placeholder: '192.168.1.1' });

    root.appendChild(h('div.grid.cols-2', null,
      card('Statische Route', null, [
        field('Ziel-Netz (CIDR)', destInput),
        field('Gateway', gwInput),
        field('Administrative Distanz', distInput),
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Route hinzufügen',
            onclick: () => {
              if (!destInput.value || !gwInput.value) { toast('Ziel und Gateway angeben.', 'err'); return; }
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
            text: 'Route entfernen',
            onclick: () => {
              if (!destInput.value || !gwInput.value) { toast('Ziel und Gateway angeben.', 'err'); return; }
              propose('routing.set', {
                remove_routes: [{ destination: destInput.value, gateway: gwInput.value }],
              }).then((ok) => ok && refresh());
            },
          }),
        ),
      ]),
      card('Globales Routing', null, [
        h('p.note', { text: `IP-Routing ist derzeit ${routingOn ? 'aktiv' : 'vermutlich inaktiv'}.` }),
        h('div.form-actions', null,
          h('button.btn', {
            text: 'IP-Routing einschalten',
            onclick: () => propose('routing.set', { enabled: true }).then((ok) => ok && refresh()),
          }),
          h('button.btn', {
            text: 'IP-Routing ausschalten',
            onclick: () => propose('routing.set', { enabled: false }).then((ok) => ok && refresh()),
          }),
        ),
        field('Default-Gateway', defGwInput, '(nur ohne IP-Routing relevant)'),
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Default-Gateway setzen',
            onclick: () => {
              if (!defGwInput.value) { toast('Gateway angeben.', 'err'); return; }
              propose('routing.set', { default_gateway: defGwInput.value }).then((ok) => ok && refresh());
            },
          }),
        ),
      ]),
    ));

    root.appendChild(rawCard('RIP', data.rip));
    root.appendChild(rawCard('DHCP Helper-Adressen', data.helper));
  },
};

export default [neighbors, forwarding, routing];

function normMac(mac) {
  return String(mac || '').toLowerCase().replace(/[^0-9a-f]/g, '');
}
