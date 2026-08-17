// Management access, credentials, SNMP, port security and the read-only views
// of 802.1X / DHCP snooping / ARP protect / RADIUS / TACACS.

import { api } from '../api.js';
import { propose } from '../changes.js';
import {
  badge, card, checkbox, field, h, input, rawBlock, select, structCard, structured, table, toast,
} from '../ui.js';

const access = {
  id: 'access',
  title: 'Access & accounts',
  icon: '🔑',
  group: 'Security',

  async render(root, ctx) {
    const { data } = await api.data('security');
    const refresh = () => ctx.reload();
    // Read the structured pairs, not the raw text -- words like "Enabled"
    // appear in headings and would make a substring test always true.
    const protoState = (fetch, ...labelParts) => {
      const pairs = Object.entries((fetch.data && fetch.data.kv) || {});
      for (const part of labelParts) {
        const hit = pairs.find(([k]) => k.toLowerCase().includes(part));
        if (hit) return /yes|enab|^on$/i.test(hit[1]) ? 'on' : 'off';
      }
      return 'unknown';
    };
    const sshOn = protoState(data.ssh, 'ssh enabled', 'ip ssh');
    const telnetOn = protoState(data.telnet, 'telnet-server', 'telnet enabled');
    const webOn = protoState(data.web, 'web access', 'web management', 'web-management');

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'Access & accounts' }),
      h('p', { text: 'Management protocols and local credentials' }),
    ));

    const sshSel = select([['', 'unchanged'], ['1', 'ein'], ['0', 'aus']]);
    const telnetSel = select([['', 'unchanged'], ['1', 'ein'], ['0', 'aus']]);
    const webSel = select([['', 'unchanged'], ['1', 'ein'], ['0', 'aus']]);
    const idleInput = input({ type: 'number', placeholder: 'seconds' });

    root.appendChild(h('div.grid.cols-2', null,
      card('Management protocols', null, [
        h('p.note', {
          text: `Detected right now: SSH ${sshOn} · Telnet ${telnetOn} · web ${webOn}`,
        }),
        field('SSH', sshSel),
        field('Telnet', telnetSel),
        field('Web interface', webSel),
        field('Console timeout', idleInput, '(0 = never)'),
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Apply',
            onclick: () => {
              const payload = {};
              if (sshSel.value) payload.ssh = sshSel.value === '1';
              if (telnetSel.value) payload.telnet = telnetSel.value === '1';
              if (webSel.value) payload.web = webSel.value === '1';
              if (idleInput.value !== '') payload.idle_timeout = Number(idleInput.value);
              if (!Object.keys(payload).length) { toast('Nothing changed.', 'info'); return; }
              propose('access.set', payload).then((ok) => ok && refresh());
            },
          }),
        ),
        structured(data.ssh), structured(data.telnet), structured(data.web),
      ]),
      card('Passwords', null, [
        credentialForm('manager', refresh),
        h('hr', { style: { border: 'none', borderTop: '1px solid var(--line-soft)', margin: '12px 0' } }),
        credentialForm('operator', refresh),
      ]),
    ));

    root.appendChild(structCard('Authentication methods', data.authentication));
    root.appendChild(structCard('RADIUS', data.radius));
    root.appendChild(structCard('TACACS+', data.tacacs));
  },
};

function credentialForm(role, refresh) {
  const userInput = input({ placeholder: 'user name (optional)' });
  const passInput = input({ type: 'password', placeholder: 'new password' });
  return h('div', null,
    h('h4', { text: role === 'manager' ? 'Manager (full access)' : 'Operator (read only)',
      style: { fontSize: '12px', color: 'var(--fg-dim)', marginBottom: '8px' } }),
    field('User name', userInput),
    field('Password', passInput),
    h('div.form-actions', null,
      h('button.btn.btn-primary.btn-sm', {
        text: 'Set',
        onclick: () => {
          if (!passInput.value) { toast('Enter a password.', 'err'); return; }
          propose('credentials.set', {
            role, username: userInput.value, password: passInput.value,
          }).then((ok) => { if (ok) { passInput.value = ''; refresh(); } });
        },
      }),
      h('button.btn.btn-danger.btn-sm', {
        text: 'Remove',
        onclick: () => propose('credentials.set', { role, remove: true }).then((ok) => ok && refresh()),
      }),
    ),
  );
}

const snmp = {
  id: 'snmp',
  title: 'SNMP',
  icon: '◉',
  group: 'Security',

  async render(root, ctx) {
    const { data } = await api.data('security');
    const refresh = () => ctx.reload();
    const snmp = data.snmp.data || {};
    const communities = snmp.communities || [];
    const receivers = snmp.receivers || [];
    const categories = snmp.categories || [];

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'SNMP' }),
      h('p', {
        text: `${communities.length} community string(s) · ${receivers.length} trap receiver(s)`,
      }),
    ));

    root.appendChild(card('Communities', data.snmp.command, [
      table([
        { key: 'name', label: 'Community', mono: true },
        { key: 'mib_view', label: 'MIB view' },
        { key: 'write_access', label: 'Write access' },
        {
          key: 'x',
          label: '',
          render: (c) => h('button.btn.btn-sm', {
            text: 'Remove',
            onclick: () => propose('snmp.set', { remove_communities: [c.name] }).then((ok) => ok && refresh()),
          }),
        },
      ], communities, { emptyText: 'No community strings configured.' }),
    ], null, true));

    root.appendChild(h('div.grid.cols-2', null,
      card('Trap receivers', snmp.link_change_ports
        ? `link-change traps on: ${snmp.link_change_ports}` : null, [
        table([
          { key: 'address', label: 'Address', mono: true },
          { key: 'community', label: 'Community', mono: true },
          { key: 'events', label: 'Events' },
          { key: 'type', label: 'Type' },
        ], receivers, { emptyText: 'No trap receivers configured — nobody is being notified.' }),
      ], null, true),
      card('Trap categories', null, [
        table([
          { key: 'name', label: 'Category' },
          {
            key: 'status',
            label: 'Status',
            render: (c) => badge(c.status, /disabl|off/i.test(c.status) ? 'mute' : 'ok'),
          },
        ], categories, { emptyText: 'This firmware reports no trap categories.' }),
      ], null, true),
    ));

    root.appendChild(card(null, null, [rawBlock(data.snmp)]));

    const nameInput = input({ placeholder: 'e.g. monitoring' });
    const accessSel = select([['operator', 'operator (read)'], ['manager', 'manager (write)']]);
    const unrestricted = checkbox('unrestricted (full write access)', false);
    const hostInput = input({ placeholder: '10.0.0.50' });
    const hostCommunity = input({ placeholder: 'community for traps' });

    root.appendChild(h('div.grid.cols-2', null,
      card('Add community', null, [
        field('Name', nameInput),
        field('Access', accessSel),
        unrestricted.el,
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Add',
            onclick: () => {
              if (!nameInput.value) { toast('Enter a name.', 'err'); return; }
              propose('snmp.set', {
                add_communities: [{
                  name: nameInput.value,
                  access: accessSel.value,
                  unrestricted: unrestricted.input.checked,
                }],
              }).then((ok) => ok && refresh());
            },
          }),
        ),
      ]),
      card('Trap receivers', null, [
        field('Host', hostInput),
        field('Community', hostCommunity),
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Add',
            onclick: () => {
              if (!hostInput.value || !hostCommunity.value) { toast('Enter host and community.', 'err'); return; }
              propose('snmp.set', {
                add_hosts: [{ ip: hostInput.value, community: hostCommunity.value }],
              }).then((ok) => ok && refresh());
            },
          }),
          h('button.btn', {
            text: 'Remove',
            onclick: () => {
              if (!hostInput.value) { toast('Enter a host.', 'err'); return; }
              propose('snmp.set', { remove_hosts: [hostInput.value] }).then((ok) => ok && refresh());
            },
          }),
        ),
      ]),
    ));
  },
};

const portSecurity = {
  id: 'portsec',
  title: 'Port security',
  icon: '⛨',
  group: 'Security',

  async render(root, ctx) {
    const [{ data }, { data: portData }] = await Promise.all([
      api.data('security'), api.data('ports'),
    ]);
    const refresh = () => ctx.reload();
    const ports = (portData.ports || []).filter((p) => !/^trk/i.test(p.port));

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'Port security' }),
      h('p', { text: 'MAC learn mode and intrusion response per port' }),
    ));

    const picker = h('select', { multiple: true, size: 10, style: { height: 'auto' } });
    for (const port of ports) {
      picker.appendChild(h('option', {
        value: port.port,
        text: `${port.port}${port.name ? ` — ${port.name}` : ''}${port.intrusion === 'Yes' ? '  ⚠ Intrusion' : ''}`,
      }));
    }
    const learnSel = select([
      ['continuous', 'continuous (default, no limit)'],
      ['static', 'static (fixed MAC list)'],
      ['limited-continuous', 'limited-continuous'],
      ['port-access', 'port-access (802.1X)'],
    ]);
    const limitInput = input({ type: 'number', min: 1, max: 32, placeholder: 'e.g. 1' });
    const actionSel = select([
      ['none', 'no action'], ['send-alarm', 'send alarm'], ['send-disable', 'disable the port'],
    ]);

    root.appendChild(card('Configure', null, [
      h('div.grid.cols-2', null,
        field('Ports', picker),
        h('div', null,
          field('Learn mode', learnSel),
          field('MAC limit', limitInput),
          field('On violation', actionSel),
          h('div.form-actions', null,
            h('button.btn.btn-primary', {
              text: 'Apply',
              onclick: () => {
                const sel = [...picker.selectedOptions].map((o) => o.value);
                if (!sel.length) { toast('No ports selected.', 'err'); return; }
                propose('port.security', {
                  ports: sel,
                  learn_mode: learnSel.value,
                  address_limit: limitInput.value ? Number(limitInput.value) : undefined,
                  action: actionSel.value,
                }).then((ok) => ok && refresh());
              },
            }),
            h('button.btn', {
              text: 'Remove port security',
              onclick: () => {
                const sel = [...picker.selectedOptions].map((o) => o.value);
                if (!sel.length) { toast('No ports selected.', 'err'); return; }
                propose('port.security', { ports: sel, remove: true }).then((ok) => ok && refresh());
              },
            }),
          ),
        ),
      ),
    ]));

    root.appendChild(structCard('Current state', data.port_security));
    root.appendChild(structCard('802.1X port access', data['8021x']));
    root.appendChild(structCard('DHCP snooping', data.dhcp_snooping));
    root.appendChild(structCard('ARP protect', data.arp_protect));
  },
};

export default [access, snmp, portSecurity];
