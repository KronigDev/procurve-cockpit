// Identity, time, syslog, QoS and ACLs.

import { api } from '../api.js';
import { propose } from '../changes.js';
import {
  card, field, h, input, kv, rawBlock, rawCard, select, table, toast,
} from '../ui.js';

const system = {
  id: 'system',
  title: 'System & Zeit',
  icon: '⚙',
  group: 'System',

  async render(root, ctx) {
    const [{ data: sys }, { data: logs }] = await Promise.all([
      api.data('system'), api.data('logging'),
    ]);
    const refresh = () => ctx.reload();
    const info = sys.info.data || {};

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'System & Zeit' }),
      h('p', { text: info.name || '' }),
    ));

    const hostInput = input({ value: info.name || '' });
    const locInput = input({ value: info.location || '' });
    const contactInput = input({ value: info.contact || '' });
    const bannerInput = h('textarea', { placeholder: 'Login-Banner (leer = entfernen)' });

    const tzInput = input({ type: 'number', value: info.time_zone || '', placeholder: 'Minuten, z. B. 60' });
    const dstSel = select([
      ['', 'unverändert'], ['none', 'keine'], ['western-europe', 'Westeuropa (EU)'],
      ['middle-europe-and-portugal', 'Mitteleuropa/Portugal'], ['alaska', 'Alaska'],
      ['southern-hemisphere', 'Südhalbkugel'], ['user-defined', 'benutzerdefiniert'],
    ]);
    const sntpInput = input({ placeholder: '10.0.0.1, pool.ntp.org' });

    root.appendChild(h('div.grid.cols-2', null,
      card('Identität', null, [
        field('Hostname', hostInput),
        field('Standort', locInput, '(SNMP location)'),
        field('Kontakt', contactInput, '(SNMP contact)'),
        field('Login-Banner', bannerInput),
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Übernehmen',
            onclick: () => {
              const payload = {};
              if (hostInput.value && hostInput.value !== info.name) payload.hostname = hostInput.value;
              if (locInput.value !== (info.location || '')) payload.location = locInput.value;
              if (contactInput.value !== (info.contact || '')) payload.contact = contactInput.value;
              if (bannerInput.value.trim()) payload.banner = bannerInput.value.trim();
              if (!Object.keys(payload).length) { toast('Nichts geändert.', 'info'); return; }
              propose('system.set', payload).then((ok) => ok && refresh());
            },
          }),
        ),
      ]),
      card('Zeit', logs.time.command, [
        h('pre.raw', { text: logs.time.raw || '' , style: { maxHeight: '110px' } }),
        field('Zeitzone', tzInput, '(Offset in Minuten, MEZ = 60)'),
        field('Sommerzeit-Regel', dstSel),
        field('SNTP-Server', sntpInput, '(kommagetrennt)'),
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Zeit übernehmen',
            onclick: () => {
              const payload = {};
              if (tzInput.value !== '') payload.timezone = Number(tzInput.value);
              if (dstSel.value) payload.daylight_rule = dstSel.value;
              const servers = sntpInput.value.split(',').map((s) => s.trim()).filter(Boolean);
              if (servers.length) payload.sntp_servers = servers;
              if (!Object.keys(payload).length) { toast('Nichts geändert.', 'info'); return; }
              propose('system.set', payload).then((ok) => ok && refresh());
            },
          }),
        ),
        rawBlock(logs.sntp),
      ]),
    ));

    root.appendChild(card('Systeminformationen', sys.info.command, [
      kv(Object.entries(info.raw || {})),
      rawBlock(sys.info),
    ]));
  },
};

const logging = {
  id: 'logs',
  title: 'Log & Syslog',
  icon: '☰',
  group: 'System',

  async render(root, ctx) {
    const { data } = await api.data('logging');
    const refresh = () => ctx.reload();

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'Ereignisprotokoll' }),
      h('p', { text: data.log.command }),
    ));

    let needle = '';
    const logHost = h('pre.raw', { style: { maxHeight: '52vh' } });
    const lines = (data.log.raw || '').split('\n');
    const drawLog = () => {
      logHost.textContent = (needle
        ? lines.filter((l) => l.toLowerCase().includes(needle))
        : lines).join('\n') || '(keine Einträge)';
    };
    drawLog();

    root.appendChild(card('Log', `${lines.length} Zeilen`, [
      h('div.toolbar', null,
        input({
          type: 'search', placeholder: 'Filter …',
          oninput: (ev) => { needle = ev.target.value.trim().toLowerCase(); drawLog(); },
        }),
        h('span.spacer'),
        h('button.btn.btn-sm', {
          text: 'Als Datei speichern',
          onclick: () => downloadText('switch-log.txt', data.log.raw || ''),
        }),
      ),
      logHost,
    ]));

    const serverInput = input({ placeholder: '10.0.0.9' });
    const facilitySel = select([
      ['', 'unverändert'], ...Array.from({ length: 8 }, (_, i) => [`local${i}`, `local${i}`]),
      ['kern', 'kern'], ['user', 'user'], ['daemon', 'daemon'], ['syslog', 'syslog'],
    ]);
    const sevSel = select([
      ['', 'unverändert'], ['debug', 'debug'], ['info', 'info'], ['warning', 'warning'],
      ['error', 'error'], ['major', 'major'],
    ]);

    root.appendChild(card('Syslog-Ziel', null, [
      field('Server', serverInput),
      field('Facility', facilitySel),
      field('Mindest-Schweregrad', sevSel),
      h('div.form-actions', null,
        h('button.btn.btn-primary', {
          text: 'Hinzufügen',
          onclick: () => {
            const payload = {};
            if (serverInput.value) payload.add_servers = [serverInput.value];
            if (facilitySel.value) payload.facility = facilitySel.value;
            if (sevSel.value) payload.severity = sevSel.value;
            if (!Object.keys(payload).length) { toast('Nichts angegeben.', 'info'); return; }
            propose('logging.set', payload).then((ok) => ok && refresh());
          },
        }),
        h('button.btn', {
          text: 'Entfernen',
          onclick: () => {
            if (!serverInput.value) { toast('Server angeben.', 'err'); return; }
            propose('logging.set', { remove_servers: [serverInput.value] }).then((ok) => ok && refresh());
          },
        }),
      ),
    ]));

    root.appendChild(rawCard('Debug-Ziele', data.debug));
  },
};

const qos = {
  id: 'qos',
  title: 'QoS & Rate-Limit',
  icon: '⇅',
  group: 'Konfiguration',

  async render(root, ctx) {
    const [{ data }, { data: portData }] = await Promise.all([api.data('qos'), api.data('ports')]);
    const refresh = () => ctx.reload();
    const ports = (portData.ports || []).filter((p) => !/^trk/i.test(p.port));

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'QoS & Rate-Limiting' }),
      h('p', { text: 'Priorisierung und Bandbreitenbegrenzung' }),
    ));

    const portSel = select(ports.map((p) => [p.port, `${p.port}${p.name ? ` — ${p.name}` : ''}`]));
    const prioSel = select(Array.from({ length: 8 }, (_, i) => [String(i), `Priorität ${i}`]));
    const rlPortSel = select(ports.map((p) => [p.port, `${p.port}${p.name ? ` — ${p.name}` : ''}`]));
    const rlDirSel = select([['in', 'eingehend'], ['out', 'ausgehend']]);
    const rlPct = input({ type: 'number', min: 1, max: 100, placeholder: '50' });

    root.appendChild(h('div.grid.cols-2', null,
      card('Port-Priorität (802.1p)', null, [
        field('Port', portSel),
        field('Priorität', prioSel),
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Setzen',
            onclick: () => propose('qos.set', {
              port_priority: [{ port: portSel.value, priority: Number(prioSel.value) }],
            }).then((ok) => ok && refresh()),
          }),
        ),
      ]),
      card('Rate-Limit', null, [
        field('Port', rlPortSel),
        field('Richtung', rlDirSel),
        field('Anteil der Linkrate', rlPct, '(%)'),
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Setzen',
            onclick: () => {
              if (!rlPct.value) { toast('Prozentwert angeben.', 'err'); return; }
              propose('qos.set', {
                rate_limit: [{
                  port: rlPortSel.value, direction: rlDirSel.value, percent: Number(rlPct.value),
                }],
              }).then((ok) => ok && refresh());
            },
          }),
        ),
      ]),
    ));

    root.appendChild(rawCard('Queue-Konfiguration', data.queue));
    root.appendChild(rawCard('Port-Prioritäten', data.port_priority));
    root.appendChild(rawCard('DSCP-Mapping', data.dscp));
    root.appendChild(rawCard('Device-Priority', data.device_priority));
    root.appendChild(rawCard('Rate-Limits', data.rate_limit));
  },
};

const acls = {
  id: 'acls',
  title: 'ACLs',
  icon: '⛉',
  group: 'Sicherheit',

  async render(root, ctx) {
    const { data } = await api.data('acls');

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'Access Control Lists' }),
      h('p', { text: 'ACLs werden als CLI-Block bearbeitet — das ist auf ProVision der einzige verlustfreie Weg.' }),
    ));

    const editor = h('textarea', {
      style: { minHeight: '240px' },
      placeholder: [
        'ip access-list extended "GAESTE"',
        '  10 deny ip 0.0.0.0 255.255.255.255 192.168.1.0 0.0.0.255',
        '  20 permit ip 0.0.0.0 255.255.255.255 0.0.0.0 255.255.255.255',
        '  exit',
        'vlan 20 ip access-group "GAESTE" in',
      ].join('\n'),
    });

    root.appendChild(card('ACL-Editor', null, [
      editor,
      h('div.form-actions', null,
        h('button.btn.btn-primary', {
          text: 'Vorschau & Anwenden',
          onclick: () => {
            const lines = editor.value.split('\n').map((l) => l.trim()).filter(Boolean);
            if (!lines.length) { toast('Keine Zeilen.', 'err'); return; }
            propose('raw', { lines }).then((ok) => ok && ctx.reload());
          },
        }),
        h('button.btn', {
          text: 'Bestehende ACL-Config einfügen',
          onclick: () => { editor.value = data.config.raw || ''; },
        }),
      ),
      h('p.note', { text: 'ACL-Syntax wird vom Switch geprüft, nicht von dieser Oberfläche.' }),
    ]));

    root.appendChild(rawCard('ACL-Übersicht', data.list));
    root.appendChild(rawCard('ACL-Konfiguration', data.config));
    root.appendChild(rawCard('Zuordnung zu Ports/VLANs', data.ports));
  },
};

export default [system, logging, qos, acls];

export function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const link = h('a', { href: url, download: filename });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
