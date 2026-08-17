// Device management long tail: MAC lockout / static MACs, fault finder,
// credentials handling, sessions, SNMPv3, IPv6, AAA views.

import { api } from '../api.js';
import { propose } from '../changes.js';
import {
  card, field, h, input, select, structCard, toast,
} from '../ui.js';

function maybeCard(title, fetch) {
  if (!fetch || fetch.error || !(fetch.raw || '').trim()) return null;
  return structCard(title, fetch);
}

export default {
  id: 'extras',
  title: 'Device extras',
  icon: '⚒',
  group: 'System',

  async render(root) {
    const { data } = await api.data('extras');

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'Device extras' }),
      h('p', { text: 'MAC controls · fault finder · credentials · sessions · AAA' }),
    ));

    // ── MAC controls ────────────────────────────────────────────────────
    const lockMac = input({ placeholder: 'aabbcc-ddeeff or aa:bb:cc:dd:ee:ff', spellcheck: 'false' });
    const statMac = input({ placeholder: 'aabbcc-ddeeff', spellcheck: 'false' });
    const statVlan = input({ type: 'number', min: 1, max: 4094, placeholder: 'VLAN id' });
    const statPort = input({ placeholder: 'port, e.g. 7', style: { maxWidth: '120px' } });

    root.appendChild(h('div.grid.cols-2', null,
      card('MAC lockout', 'lockout-mac', [
        h('p.note', { text: 'A locked-out MAC is dropped on every port and VLAN.' }),
        field('MAC address', lockMac),
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Lock out',
            onclick: () => {
              if (!lockMac.value.trim()) { toast('Enter a MAC address.', 'err'); return; }
              propose('mac.lockout', { mac: lockMac.value.trim() });
            },
          }),
          h('button.btn', {
            text: 'Remove lockout',
            onclick: () => {
              if (!lockMac.value.trim()) { toast('Enter a MAC address.', 'err'); return; }
              propose('mac.lockout', { mac: lockMac.value.trim(), remove: true });
            },
          }),
        ),
      ]),
      card('Static MAC', 'static-mac', [
        h('p.note', { text: 'Pins a MAC to one port in one VLAN.' }),
        field('MAC address', statMac),
        field('VLAN', statVlan),
        field('Port', statPort),
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Pin',
            onclick: () => {
              if (!statMac.value.trim() || !statVlan.value || !statPort.value.trim()) {
                toast('MAC, VLAN and port are required.', 'err'); return;
              }
              propose('mac.static', {
                mac: statMac.value.trim(),
                vlan: Number(statVlan.value),
                port: statPort.value.trim(),
              });
            },
          }),
          h('button.btn', {
            text: 'Remove',
            onclick: () => {
              if (!statMac.value.trim() || !statVlan.value) {
                toast('MAC and VLAN are required.', 'err'); return;
              }
              propose('mac.static', {
                mac: statMac.value.trim(),
                vlan: Number(statVlan.value),
                port: statPort.value.trim() || '1',
                remove: true,
              });
            },
          }),
        ),
      ]),
    ));

    // ── fault finder + credentials handling ─────────────────────────────
    const ffFault = select([
      'all', 'broadcast-storm', 'link-flap', 'loss-of-link', 'bad-cable',
      'too-long-cable', 'over-bandwidth', 'bad-driver', 'bad-transceiver',
      'duplex-mismatch-hdx', 'duplex-mismatch-fdx',
    ].map((f) => [f, f]));
    const ffSens = select([['low', 'low'], ['medium', 'medium'], ['high', 'high']]);
    const ffAction = select([
      ['warn', 'warn (log only)'],
      ['warn-and-disable', 'warn and disable the port'],
    ]);

    const credToggle = (label, feature) => h('div.form-actions', { style: { alignItems: 'center' } },
      h('span', { text: label, style: { minWidth: '180px', fontSize: '12.5px' } }),
      h('button.btn.btn-sm', {
        text: 'Enable',
        onclick: () => propose('protocol.toggle', { feature, enabled: true }),
      }),
      h('button.btn.btn-sm', {
        text: 'Disable',
        onclick: () => propose('protocol.toggle', { feature, enabled: false }),
      }),
    );

    root.appendChild(h('div.grid.cols-2', null,
      card('Fault finder', 'fault-finder', [
        field('Check', ffFault),
        field('Sensitivity', ffSens),
        field('Action', ffAction),
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Apply',
            onclick: () => propose('fault_finder.set', {
              fault: ffFault.value, sensitivity: ffSens.value, action: ffAction.value,
            }),
          }),
        ),
      ]),
      card('Config file & USB behaviour', null, [
        credToggle('Include credentials in config', 'include-credentials'),
        credToggle('Encrypt credentials', 'encrypt-credentials'),
        credToggle('USB autorun', 'autorun'),
        h('p.note', { text: 'Current state is in the cards below; every change is staged with its risks.' }),
      ]),
    ));

    // ── read cards -- hidden on trains that reject the command ──────────
    for (const [title, fetch] of [
      ['Locked-out MACs', data.lockout_mac],
      ['Static MACs', data.static_mac],
      ['Fault finder configuration', data.fault_finder],
      ['Source-port filters', data.filters],
      ['Front panel security', data.front_panel],
      ['Management addresses', data.management],
      ['Active sessions', data.sessions],
      ['Console settings', data.console],
      ['SNMPv3', data.snmpv3],
      ['IPv6', data.ipv6],
      ['Key chains', data.key_chain],
      ['AAA accounting', data.accounting],
      ['AAA authorization', data.authorization],
      ['TCP push preserve', data.tcp_push],
      ['Encrypt credentials', data.encrypt_credentials],
      ['Include credentials', data.include_credentials],
      ['Login banner', data.banner],
      ['USB autorun', data.autorun],
      ['Control-plane protection', data.control_plane],
    ]) {
      const node = maybeCard(title, fetch);
      if (node) root.appendChild(node);
    }
  },
};
