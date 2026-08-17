// Management access, credentials, SNMP, port security and the read-only views
// of 802.1X / DHCP snooping / ARP protect / RADIUS / TACACS.

import { api } from '../api.js';
import { propose } from '../changes.js';
import {
  card, checkbox, field, h, input, rawBlock, rawCard, select, table, toast,
} from '../ui.js';

const access = {
  id: 'access',
  title: 'Zugang & Konten',
  icon: '🔑',
  group: 'Sicherheit',

  async render(root, ctx) {
    const { data } = await api.data('security');
    const refresh = () => ctx.reload();
    const sshOn = /enabled/i.test(data.ssh.raw);
    const telnetOn = !/disabled/i.test(data.telnet.raw);
    const webOn = /enabled/i.test(data.web.raw);

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'Zugang & Konten' }),
      h('p', { text: 'Management-Protokolle und lokale Zugangsdaten' }),
    ));

    const sshSel = select([['', 'unverändert'], ['1', 'ein'], ['0', 'aus']]);
    const telnetSel = select([['', 'unverändert'], ['1', 'ein'], ['0', 'aus']]);
    const webSel = select([['', 'unverändert'], ['1', 'ein'], ['0', 'aus']]);
    const idleInput = input({ type: 'number', placeholder: 'Sekunden' });

    root.appendChild(h('div.grid.cols-2', null,
      card('Management-Protokolle', null, [
        h('p.note', {
          text: `Aktuell erkannt: SSH ${sshOn ? 'ein' : 'aus'} · Telnet ${telnetOn ? 'ein' : 'aus'} · Web ${webOn ? 'ein' : 'aus'}`,
        }),
        field('SSH', sshSel),
        field('Telnet', telnetSel),
        field('Web-Oberfläche', webSel),
        field('Konsolen-Timeout', idleInput, '(0 = nie)'),
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Übernehmen',
            onclick: () => {
              const payload = {};
              if (sshSel.value) payload.ssh = sshSel.value === '1';
              if (telnetSel.value) payload.telnet = telnetSel.value === '1';
              if (webSel.value) payload.web = webSel.value === '1';
              if (idleInput.value !== '') payload.idle_timeout = Number(idleInput.value);
              if (!Object.keys(payload).length) { toast('Nichts geändert.', 'info'); return; }
              propose('access.set', payload).then((ok) => ok && refresh());
            },
          }),
        ),
        rawBlock(data.ssh), rawBlock(data.telnet), rawBlock(data.web),
      ]),
      card('Passwörter', null, [
        credentialForm('manager', refresh),
        h('hr', { style: { border: 'none', borderTop: '1px solid var(--line-soft)', margin: '12px 0' } }),
        credentialForm('operator', refresh),
      ]),
    ));

    root.appendChild(rawCard('Authentifizierungsmethoden', data.authentication));
    root.appendChild(rawCard('RADIUS', data.radius));
    root.appendChild(rawCard('TACACS+', data.tacacs));
  },
};

function credentialForm(role, refresh) {
  const userInput = input({ placeholder: 'Benutzername (optional)' });
  const passInput = input({ type: 'password', placeholder: 'Neues Passwort' });
  return h('div', null,
    h('h4', { text: role === 'manager' ? 'Manager (Vollzugriff)' : 'Operator (nur lesen)',
      style: { fontSize: '12px', color: 'var(--fg-dim)', marginBottom: '8px' } }),
    field('Benutzername', userInput),
    field('Passwort', passInput),
    h('div.form-actions', null,
      h('button.btn.btn-primary.btn-sm', {
        text: 'Setzen',
        onclick: () => {
          if (!passInput.value) { toast('Passwort eingeben.', 'err'); return; }
          propose('credentials.set', {
            role, username: userInput.value, password: passInput.value,
          }).then((ok) => { if (ok) { passInput.value = ''; refresh(); } });
        },
      }),
      h('button.btn.btn-danger.btn-sm', {
        text: 'Entfernen',
        onclick: () => propose('credentials.set', { role, remove: true }).then((ok) => ok && refresh()),
      }),
    ),
  );
}

const snmp = {
  id: 'snmp',
  title: 'SNMP',
  icon: '◉',
  group: 'Sicherheit',

  async render(root, ctx) {
    const { data } = await api.data('security');
    const refresh = () => ctx.reload();
    const communities = data.snmp.data || [];

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'SNMP' }),
      h('p', { text: `${communities.length} Community-Strings` }),
    ));

    root.appendChild(card('Communities', data.snmp.command, [
      table([
        { key: 'name', label: 'Community', mono: true },
        { key: 'mib_view', label: 'MIB-View' },
        { key: 'write_access', label: 'Schreibzugriff' },
        {
          key: 'x',
          label: '',
          render: (c) => h('button.btn.btn-sm', {
            text: 'Entfernen',
            onclick: () => propose('snmp.set', { remove_communities: [c.name] }).then((ok) => ok && refresh()),
          }),
        },
      ], communities),
      rawBlock(data.snmp),
    ], null, true));

    const nameInput = input({ placeholder: 'z. B. monitoring' });
    const accessSel = select([['operator', 'operator (lesen)'], ['manager', 'manager (schreiben)']]);
    const unrestricted = checkbox('unrestricted (voller Schreibzugriff)', false);
    const hostInput = input({ placeholder: '10.0.0.50' });
    const hostCommunity = input({ placeholder: 'Community für Traps' });

    root.appendChild(h('div.grid.cols-2', null,
      card('Community hinzufügen', null, [
        field('Name', nameInput),
        field('Zugriff', accessSel),
        unrestricted.el,
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Hinzufügen',
            onclick: () => {
              if (!nameInput.value) { toast('Name angeben.', 'err'); return; }
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
      card('Trap-Empfänger', null, [
        field('Host', hostInput),
        field('Community', hostCommunity),
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Hinzufügen',
            onclick: () => {
              if (!hostInput.value || !hostCommunity.value) { toast('Host und Community angeben.', 'err'); return; }
              propose('snmp.set', {
                add_hosts: [{ ip: hostInput.value, community: hostCommunity.value }],
              }).then((ok) => ok && refresh());
            },
          }),
          h('button.btn', {
            text: 'Entfernen',
            onclick: () => {
              if (!hostInput.value) { toast('Host angeben.', 'err'); return; }
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
  title: 'Port-Security',
  icon: '⛨',
  group: 'Sicherheit',

  async render(root, ctx) {
    const [{ data }, { data: portData }] = await Promise.all([
      api.data('security'), api.data('ports'),
    ]);
    const refresh = () => ctx.reload();
    const ports = (portData.ports || []).filter((p) => !/^trk/i.test(p.port));

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'Port-Security' }),
      h('p', { text: 'MAC-Lernmodus und Intrusion-Reaktion pro Port' }),
    ));

    const picker = h('select', { multiple: true, size: 10, style: { height: 'auto' } });
    for (const port of ports) {
      picker.appendChild(h('option', {
        value: port.port,
        text: `${port.port}${port.name ? ` — ${port.name}` : ''}${port.intrusion === 'Yes' ? '  ⚠ Intrusion' : ''}`,
      }));
    }
    const learnSel = select([
      ['continuous', 'continuous (Standard, keine Begrenzung)'],
      ['static', 'static (feste MAC-Liste)'],
      ['limited-continuous', 'limited-continuous'],
      ['port-access', 'port-access (802.1X)'],
    ]);
    const limitInput = input({ type: 'number', min: 1, max: 32, placeholder: 'z. B. 1' });
    const actionSel = select([
      ['none', 'keine Aktion'], ['send-alarm', 'Alarm senden'], ['send-disable', 'Port abschalten'],
    ]);

    root.appendChild(card('Konfigurieren', null, [
      h('div.grid.cols-2', null,
        field('Ports', picker),
        h('div', null,
          field('Lernmodus', learnSel),
          field('MAC-Limit', limitInput),
          field('Bei Verstoß', actionSel),
          h('div.form-actions', null,
            h('button.btn.btn-primary', {
              text: 'Übernehmen',
              onclick: () => {
                const sel = [...picker.selectedOptions].map((o) => o.value);
                if (!sel.length) { toast('Keine Ports gewählt.', 'err'); return; }
                propose('port.security', {
                  ports: sel,
                  learn_mode: learnSel.value,
                  address_limit: limitInput.value ? Number(limitInput.value) : undefined,
                  action: actionSel.value,
                }).then((ok) => ok && refresh());
              },
            }),
            h('button.btn', {
              text: 'Port-Security entfernen',
              onclick: () => {
                const sel = [...picker.selectedOptions].map((o) => o.value);
                if (!sel.length) { toast('Keine Ports gewählt.', 'err'); return; }
                propose('port.security', { ports: sel, remove: true }).then((ok) => ok && refresh());
              },
            }),
          ),
        ),
      ),
    ]));

    root.appendChild(rawCard('Aktueller Stand', data.port_security));
    root.appendChild(rawCard('802.1X Port-Access', data['8021x']));
    root.appendChild(rawCard('DHCP-Snooping', data.dhcp_snooping));
    root.appendChild(rawCard('ARP-Protect', data.arp_protect));
  },
};

export default [access, snmp, portSecurity];
