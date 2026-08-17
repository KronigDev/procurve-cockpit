// Identity, time, syslog, QoS and ACLs.

import { api } from '../api.js';
import { propose } from '../changes.js';
import {
  card, field, h, input, kv, rawBlock, rawCard, select, toast,
} from '../ui.js';

const system = {
  id: 'system',
  title: 'System & time',
  icon: '⚙',
  group: 'System',

  async render(root, ctx) {
    const [{ data: sys }, { data: logs }] = await Promise.all([
      api.data('system'), api.data('logging'),
    ]);
    const refresh = () => ctx.reload();
    const info = sys.info.data || {};

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'System & time' }),
      h('p', { text: info.name || '' }),
    ));

    const hostInput = input({ value: info.name || '' });
    const locInput = input({ value: info.location || '' });
    const contactInput = input({ value: info.contact || '' });
    const bannerInput = h('textarea', { placeholder: 'login banner (empty removes it)' });

    const tzInput = input({ type: 'number', value: info.time_zone || '', placeholder: 'minutes, e.g. 60' });
    const dstSel = select([
      ['', 'unchanged'], ['none', 'none'], ['western-europe', 'Western Europe (EU)'],
      ['middle-europe-and-portugal', 'Middle Europe / Portugal'], ['alaska', 'Alaska'],
      ['southern-hemisphere', 'Southern hemisphere'], ['user-defined', 'user defined'],
    ]);
    const sntpInput = input({ placeholder: '10.0.0.1, pool.ntp.org' });

    root.appendChild(h('div.grid.cols-2', null,
      card('Identity', null, [
        field('Host name', hostInput),
        field('Location', locInput, '(SNMP location)'),
        field('Contact', contactInput, '(SNMP contact)'),
        field('Login banner', bannerInput),
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Apply',
            onclick: () => {
              const payload = {};
              if (hostInput.value && hostInput.value !== info.name) payload.hostname = hostInput.value;
              if (locInput.value !== (info.location || '')) payload.location = locInput.value;
              if (contactInput.value !== (info.contact || '')) payload.contact = contactInput.value;
              if (bannerInput.value.trim()) payload.banner = bannerInput.value.trim();
              if (!Object.keys(payload).length) { toast('Nothing changed.', 'info'); return; }
              propose('system.set', payload).then((ok) => ok && refresh());
            },
          }),
        ),
      ]),
      card('Time', logs.time.command, [
        h('pre.raw', { text: logs.time.raw || '' , style: { maxHeight: '110px' } }),
        field('Time zone', tzInput, '(offset in minutes, CET = 60)'),
        field('Daylight saving rule', dstSel),
        field('SNTP servers', sntpInput, '(comma separated)'),
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Apply time settings',
            onclick: () => {
              const payload = {};
              if (tzInput.value !== '') payload.timezone = Number(tzInput.value);
              if (dstSel.value) payload.daylight_rule = dstSel.value;
              const servers = sntpInput.value.split(',').map((s) => s.trim()).filter(Boolean);
              if (servers.length) payload.sntp_servers = servers;
              if (!Object.keys(payload).length) { toast('Nothing changed.', 'info'); return; }
              propose('system.set', payload).then((ok) => ok && refresh());
            },
          }),
        ),
        rawBlock(logs.sntp),
      ]),
    ));

    root.appendChild(card('System information', sys.info.command, [
      kv(Object.entries(info.raw || {})),
      rawBlock(sys.info),
    ]));
  },
};

const logging = {
  id: 'logs',
  title: 'Log & syslog',
  icon: '☰',
  group: 'System',

  async render(root, ctx) {
    const { data } = await api.data('logging');
    const refresh = () => ctx.reload();

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'Event log' }),
      h('p', { text: data.log.command }),
    ));

    let needle = '';
    const logHost = h('pre.raw', { style: { maxHeight: '52vh' } });
    const lines = (data.log.raw || '').split('\n');
    const drawLog = () => {
      logHost.textContent = (needle
        ? lines.filter((l) => l.toLowerCase().includes(needle))
        : lines).join('\n') || '(no entries)';
    };
    drawLog();

    root.appendChild(card('Log', `${lines.length} lines`, [
      h('div.toolbar', null,
        input({
          type: 'search', placeholder: 'Filter …',
          oninput: (ev) => { needle = ev.target.value.trim().toLowerCase(); drawLog(); },
        }),
        h('span.spacer'),
        h('button.btn.btn-sm', {
          text: 'Save to file',
          onclick: () => downloadText('switch-log.txt', data.log.raw || ''),
        }),
      ),
      logHost,
    ]));

    const serverInput = input({ placeholder: '10.0.0.9' });
    const facilitySel = select([
      ['', 'unchanged'], ...Array.from({ length: 8 }, (_, i) => [`local${i}`, `local${i}`]),
      ['kern', 'kern'], ['user', 'user'], ['daemon', 'daemon'], ['syslog', 'syslog'],
    ]);
    const sevSel = select([
      ['', 'unchanged'], ['debug', 'debug'], ['info', 'info'], ['warning', 'warning'],
      ['error', 'error'], ['major', 'major'],
    ]);

    root.appendChild(card('Syslog target', null, [
      field('Server', serverInput),
      field('Facility', facilitySel),
      field('Minimum severity', sevSel),
      h('div.form-actions', null,
        h('button.btn.btn-primary', {
          text: 'Add',
          onclick: () => {
            const payload = {};
            if (serverInput.value) payload.add_servers = [serverInput.value];
            if (facilitySel.value) payload.facility = facilitySel.value;
            if (sevSel.value) payload.severity = sevSel.value;
            if (!Object.keys(payload).length) { toast('Nothing entered.', 'info'); return; }
            propose('logging.set', payload).then((ok) => ok && refresh());
          },
        }),
        h('button.btn', {
          text: 'Remove',
          onclick: () => {
            if (!serverInput.value) { toast('Enter a server.', 'err'); return; }
            propose('logging.set', { remove_servers: [serverInput.value] }).then((ok) => ok && refresh());
          },
        }),
      ),
    ]));

    root.appendChild(rawCard('Debug destinations', data.debug));
  },
};

const qos = {
  id: 'qos',
  title: 'QoS & rate limiting',
  icon: '⇅',
  group: 'Configuration',

  async render(root, ctx) {
    const [{ data }, { data: portData }] = await Promise.all([api.data('qos'), api.data('ports')]);
    const refresh = () => ctx.reload();
    const ports = (portData.ports || []).filter((p) => !/^trk/i.test(p.port));

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'QoS & rate limiting' }),
      h('p', { text: 'Prioritisation and bandwidth limits' }),
    ));

    const portSel = select(ports.map((p) => [p.port, `${p.port}${p.name ? ` — ${p.name}` : ''}`]));
    const prioSel = select(Array.from({ length: 8 }, (_, i) => [String(i), `priority ${i}`]));
    const rlPortSel = select(ports.map((p) => [p.port, `${p.port}${p.name ? ` — ${p.name}` : ''}`]));
    const rlDirSel = select([['in', 'inbound'], ['out', 'outbound']]);
    const rlPct = input({ type: 'number', min: 1, max: 100, placeholder: '50' });

    root.appendChild(h('div.grid.cols-2', null,
      card('Port priority (802.1p)', null, [
        field('Port', portSel),
        field('Priority', prioSel),
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Set',
            onclick: () => propose('qos.set', {
              port_priority: [{ port: portSel.value, priority: Number(prioSel.value) }],
            }).then((ok) => ok && refresh()),
          }),
        ),
      ]),
      card('Rate limit', null, [
        field('Port', rlPortSel),
        field('Direction', rlDirSel),
        field('Share of link rate', rlPct, '(%)'),
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Set',
            onclick: () => {
              if (!rlPct.value) { toast('Enter a percentage.', 'err'); return; }
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

    root.appendChild(rawCard('Queue configuration', data.queue));
    root.appendChild(rawCard('Port priorities', data.port_priority));
    root.appendChild(rawCard('DSCP mapping', data.dscp));
    root.appendChild(rawCard('Device priority', data.device_priority));
    root.appendChild(rawCard('Rate limits', data.rate_limit));
  },
};

const acls = {
  id: 'acls',
  title: 'ACLs',
  icon: '⛉',
  group: 'Security',

  async render(root, ctx) {
    const { data } = await api.data('acls');

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'Access Control Lists' }),
      h('p', { text: 'ACLs are edited as a CLI block — on ProVision that is the only lossless way.' }),
    ));

    const editor = h('textarea', {
      style: { minHeight: '240px' },
      placeholder: [
        'ip access-list extended "GUESTS"',
        '  10 deny ip 0.0.0.0 255.255.255.255 192.168.1.0 0.0.0.255',
        '  20 permit ip 0.0.0.0 255.255.255.255 0.0.0.0 255.255.255.255',
        '  exit',
        'vlan 20 ip access-group "GUESTS" in',
      ].join('\n'),
    });

    root.appendChild(card('ACL editor', null, [
      editor,
      h('div.form-actions', null,
        h('button.btn.btn-primary', {
          text: 'Preview & apply',
          onclick: () => {
            const lines = editor.value.split('\n').map((l) => l.trim()).filter(Boolean);
            if (!lines.length) { toast('No lines.', 'err'); return; }
            propose('raw', { lines }).then((ok) => ok && ctx.reload());
          },
        }),
        h('button.btn', {
          text: 'Load existing ACL config',
          onclick: () => { editor.value = data.config.raw || ''; },
        }),
      ),
      h('p.note', { text: 'ACL syntax is validated by the switch, not by this interface.' }),
    ]));

    root.appendChild(rawCard('ACL overview', data.list));
    root.appendChild(rawCard('ACL configuration', data.config));
    root.appendChild(rawCard('Assignment to ports / VLANs', data.ports));
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
