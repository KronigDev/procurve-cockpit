// The L2/L3 protocol long tail: GVRP, IGMP, loop protect, UDLD, sFlow,
// DHCP relay, CDP, jumbos, TIMEP, stacking. Read cards hide themselves on
// trains that do not know the command; write forms are always offered and
// the switch validates on apply.

import { api } from '../api.js';
import { propose } from '../changes.js';
import {
  card, field, h, input, select, structCard, toast, triState,
} from '../ui.js';

/** structCard, but only when the train actually answered the command. */
function maybeCard(title, fetch) {
  if (!fetch || fetch.error || !(fetch.raw || '').trim()) return null;
  return structCard(title, fetch);
}

function toggleRow(label, feature, hint = '') {
  return h('div.form-actions', { style: { alignItems: 'center' } },
    h('span', { text: label, style: { minWidth: '180px', fontSize: '12.5px' } }),
    h('button.btn.btn-sm', {
      text: 'Enable',
      onclick: () => propose('protocol.toggle', { feature, enabled: true }),
    }),
    h('button.btn.btn-sm', {
      text: 'Disable',
      onclick: () => propose('protocol.toggle', { feature, enabled: false }),
    }),
    hint ? h('span.note', { text: hint }) : null,
  );
}

export default {
  id: 'protocols',
  title: 'Protocols',
  icon: '⌘',
  group: 'Configuration',

  async render(root) {
    const [{ data }, { data: portData }, { data: vlanData }] = await Promise.all([
      api.data('protocols'), api.data('ports'), api.data('vlans'),
    ]);
    const ports = (portData.ports || []).filter((p) => !/^trk/i.test(p.port));
    const vlans = vlanData.vlans || [];

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'Protocols' }),
      h('p', { text: 'GVRP · IGMP · loop protect · UDLD · sFlow · DHCP relay · CDP' }),
    ));

    // ── global toggles ──────────────────────────────────────────────────
    root.appendChild(card('Global protocol toggles', null, [
      toggleRow('LLDP', 'lldp'),
      toggleRow('GVRP (dynamic VLANs)', 'gvrp'),
      toggleRow('CDP', 'cdp'),
      toggleRow('DHCP relay', 'dhcp-relay'),
      toggleRow('Fastboot (skip self test)', 'fastboot'),
      toggleRow('TCP push preserve', 'tcp-push-preserve'),
      h('p.note', { text: 'Each toggle is staged like any other change — the current state is in the cards below.' }),
    ]));

    // ── IPv6 per VLAN ───────────────────────────────────────────────────
    const v6VlanSel = select(vlans.map((v) => [String(v.id), `VLAN ${v.id} — ${v.name}`]));
    root.appendChild(card('IPv6 per VLAN', 'ipv6 enable', [
      h('p.note', { text: 'Link-local IPv6 management on the chosen VLAN interface.' }),
      field('VLAN', v6VlanSel),
      h('div.form-actions', null,
        h('button.btn.btn-sm', {
          text: 'Enable IPv6',
          onclick: () => propose('vlan.update', { id: Number(v6VlanSel.value), ipv6: true }),
        }),
        h('button.btn.btn-sm', {
          text: 'Disable IPv6',
          onclick: () => propose('vlan.update', { id: Number(v6VlanSel.value), ipv6: false }),
        }),
      ),
    ]));

    // ── IGMP per VLAN ───────────────────────────────────────────────────
    const igmpVlanSel = select(vlans.map((v) => [String(v.id), `VLAN ${v.id} — ${v.name}`]));
    const igmpState = triState('IGMP snooping');
    const igmpQuerier = triState('IGMP querier');

    // ── loop protect ────────────────────────────────────────────────────
    const lpPicker = h('select', { multiple: true, size: 8, style: { height: 'auto' } });
    const lkPicker = h('select', { multiple: true, size: 8, style: { height: 'auto' } });
    for (const port of ports) {
      const label = `${port.port}${port.name ? ` — ${port.name}` : ''}`;
      lpPicker.appendChild(h('option', { value: port.port, text: label }));
      lkPicker.appendChild(h('option', { value: port.port, text: label }));
    }
    const lpTx = input({ type: 'number', min: 1, max: 10, placeholder: '5' });
    const lpTimer = input({ type: 'number', min: 0, placeholder: 'seconds, 0 = manual' });

    root.appendChild(h('div.grid.cols-2', null,
      card('IGMP per VLAN', 'ip igmp', [
        field('VLAN', igmpVlanSel),
        igmpState,
        igmpQuerier,
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Apply',
            onclick: () => {
              const payload = { vlan: Number(igmpVlanSel.value) };
              const state = igmpState.querySelector('select');
              const querier = igmpQuerier.querySelector('select');
              if (state.value) payload.enabled = state.value === '1';
              if (querier.value) payload.querier = querier.value === '1';
              if (payload.enabled === undefined && payload.querier === undefined) {
                toast('Nothing changed.', 'info'); return;
              }
              propose('igmp.set', payload);
            },
          }),
        ),
      ]),
      card('Loop protection', 'loop-protect', [
        field('Ports', lpPicker),
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Enable on ports',
            onclick: () => {
              const sel = [...lpPicker.selectedOptions].map((o) => o.value);
              if (!sel.length) { toast('No ports selected.', 'err'); return; }
              propose('loop_protect.set', { ports: sel, enabled: true });
            },
          }),
          h('button.btn', {
            text: 'Disable on ports',
            onclick: () => {
              const sel = [...lpPicker.selectedOptions].map((o) => o.value);
              if (!sel.length) { toast('No ports selected.', 'err'); return; }
              propose('loop_protect.set', { ports: sel, enabled: false });
            },
          }),
        ),
        field('Transmit interval', lpTx, '(1–10 s)'),
        field('Re-enable timer', lpTimer, '(disable-timer)'),
        h('div.form-actions', null,
          h('button.btn.btn-sm', {
            text: 'Apply timers',
            onclick: () => {
              const payload = {};
              if (lpTx.value !== '') payload.transmit_interval = Number(lpTx.value);
              if (lpTimer.value !== '') payload.disable_timer = Number(lpTimer.value);
              if (!Object.keys(payload).length) { toast('Nothing entered.', 'info'); return; }
              propose('loop_protect.set', payload);
            },
          }),
        ),
      ]),
    ));

    // ── UDLD + sFlow + option 82 ────────────────────────────────────────
    const sfInstance = select([['1', 'instance 1'], ['2', 'instance 2'], ['3', 'instance 3']]);
    const sfDest = input({ placeholder: '10.0.0.20' });
    const sfPort = input({ type: 'number', placeholder: '6343 (default)' });
    const sfSampleRate = input({ type: 'number', placeholder: 'e.g. 500 (1 in N)' });
    const sfPollInt = input({ type: 'number', placeholder: 'seconds, e.g. 30' });
    const sfPorts = input({ placeholder: '1-24 or 1,5,7' });
    const o82Sel = select([
      ['append', 'append'], ['replace', 'replace'], ['drop', 'drop'],
      ['keep', 'keep'], ['disable', 'disable option 82'],
    ]);

    root.appendChild(h('div.grid.cols-2', null,
      card('Link-keepalive (UDLD)', 'link-keepalive', [
        field('Ports', lkPicker),
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Enable',
            onclick: () => {
              const sel = [...lkPicker.selectedOptions].map((o) => o.value);
              if (!sel.length) { toast('No ports selected.', 'err'); return; }
              propose('link_keepalive.set', { ports: sel, enabled: true });
            },
          }),
          h('button.btn', {
            text: 'Disable',
            onclick: () => {
              const sel = [...lkPicker.selectedOptions].map((o) => o.value);
              if (!sel.length) { toast('No ports selected.', 'err'); return; }
              propose('link_keepalive.set', { ports: sel, enabled: false });
            },
          }),
        ),
      ]),
      card('sFlow', 'sflow …', [
        field('Instance', sfInstance),
        field('Collector address', sfDest),
        field('Collector UDP port', sfPort),
        field('Ports', sfPorts, '(for sampling/polling)'),
        field('Sampling rate', sfSampleRate, '(1 packet in N)'),
        field('Polling interval', sfPollInt, '(seconds)'),
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Configure sFlow',
            onclick: () => {
              const payload = { instance: Number(sfInstance.value) };
              if (sfDest.value.trim()) payload.destination = sfDest.value.trim();
              if (sfPort.value !== '') payload.udp_port = Number(sfPort.value);
              const portsRaw = sfPorts.value.trim();
              if (portsRaw && sfSampleRate.value !== '') {
                payload.sampling_ports = portsRaw;
                payload.sampling_rate = Number(sfSampleRate.value);
              }
              if (portsRaw && sfPollInt.value !== '') {
                payload.polling_ports = portsRaw;
                payload.polling_interval = Number(sfPollInt.value);
              }
              propose('sflow.set', payload);
            },
          }),
          h('button.btn', {
            text: 'Remove collector',
            onclick: () => propose('sflow.set', { instance: Number(sfInstance.value), remove: true }),
          }),
        ),
        field('DHCP relay option 82', o82Sel),
        h('div.form-actions', null,
          h('button.btn.btn-sm', {
            text: 'Set option 82',
            onclick: () => propose('dhcp_relay.option82', { mode: o82Sel.value }),
          }),
        ),
      ]),
    ));

    // ── read cards -- hidden on trains that reject the command ──────────
    for (const [title, fetch] of [
      ['GVRP', data.gvrp],
      ['IGMP', data.igmp],
      ['IGMP proxy', data.igmp_proxy],
      ['Loop protection', data.loop_protect],
      ['Link-keepalive', data.link_keepalive],
      ['sFlow', data.sflow],
      ['DHCP relay', data.dhcp_relay],
      ['DHCP client', data.dhcp_client],
      ['CDP', data.cdp],
      ['Jumbo frames', data.jumbos],
      ['TIMEP', data.timep],
      ['Stacking', data.stack],
    ]) {
      const node = maybeCard(title, fetch);
      if (node) root.appendChild(node);
    }
  },
};
