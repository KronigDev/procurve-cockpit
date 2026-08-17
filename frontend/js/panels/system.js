// Identity, time, syslog, QoS and ACLs.

import { api } from '../api.js';
import { propose } from '../changes.js';
import {
  card, facts, field, h, input, loading, rawBlock, select, structCard, structured,
  toast, tracked,
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

    // Current time-sync state, read from the switch (stacked `show sntp`
    // output plus the status page) so every control opens on the truth.
    const sntpKv = (logs.sntp.data && logs.sntp.data.kv) || {};
    const kvGet = (obj, part) => {
      const hit = Object.entries(obj).find(([k]) => k.toLowerCase().includes(part));
      return hit ? hit[1] : '';
    };
    const normToken = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, '-');

    const curSync = (() => {
      const v = normToken(kvGet(sntpKv, 'time sync'));
      if (!v) return '';
      if (v.includes('timep') && v.includes('sntp')) return 'timep-or-sntp';
      if (v.includes('timep')) return 'timep';
      if (v.includes('sntp')) return 'sntp';
      return 'none';
    })();
    const curSntpMode = (() => {
      const v = normToken(kvGet(sntpKv, 'sntp mode'));
      if (!v) return '';
      if (v.includes('unicast')) return 'unicast';
      if (v.includes('broadcast')) return 'broadcast';
      return 'disabled';
    })();
    const curPoll = (kvGet(sntpKv, 'poll interval').match(/\d+/) || [''])[0];
    const curDst = normToken((info.raw && info.raw['Daylight Time Rule']) || '');

    const tz = tracked('Time zone',
      input({ type: 'number', placeholder: 'minutes, e.g. 60' }),
      info.time_zone ?? '', '(offset in minutes, CET = 60)');
    const dst = tracked('Daylight saving rule', select([
      ['none', 'none'], ['western-europe', 'Western Europe (EU)'],
      ['middle-europe-and-portugal', 'Middle Europe / Portugal'], ['alaska', 'Alaska'],
      ['southern-hemisphere', 'Southern hemisphere'], ['user-defined', 'user defined'],
    ]), curDst);
    const sync = tracked('Time sync protocol', select([
      ['sntp', 'SNTP'], ['timep', 'TIMEP'],
      ['timep-or-sntp', 'TIMEP or SNTP'], ['none', 'none (no timesync)'],
    ]), curSync, '(SNTP is the modern choice)');
    const sntpMode = tracked('SNTP mode', select([
      ['unicast', 'unicast (poll the servers below)'],
      ['broadcast', 'broadcast (listen passively)'], ['disabled', 'disabled (no sntp)'],
    ]), curSntpMode);
    const poll = tracked('SNTP poll interval',
      input({ type: 'number', min: 30, max: 720, placeholder: '30–720' }),
      curPoll, '(seconds)');
    const curSntpAuth = (() => {
      const v = normToken(kvGet(sntpKv, 'authentication'));
      if (!v) return '';
      return v.includes('enab') ? '1' : '0';
    })();
    const sntpAuth = tracked('SNTP authentication',
      select([['1', 'enabled'], ['0', 'disabled']]), curSntpAuth);
    const timepMode = tracked('TIMEP mode', select([
      ['dhcp', 'DHCP (server from lease)'], ['manual', 'manual server'],
      ['disabled', 'disabled'],
    ]), '');
    const timepServer = input({ placeholder: 'TIMEP server (manual mode)' });
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
        h('p.note', { text: `Switch clock: ${(logs.time.raw || '').trim() || 'unknown'}` }),
        tz.el, dst.el, sync.el, sntpMode.el, poll.el, sntpAuth.el,
        timepMode.el,
        field('TIMEP server', timepServer, '(only for manual mode)'),
        field('SNTP servers', sntpInput, '(comma separated — setting servers also enables SNTP unicast)'),
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Apply time settings',
            onclick: () => {
              const payload = {};
              if (tz.changed() && tz.control.value !== '') payload.timezone = Number(tz.control.value);
              if (dst.changed() && dst.control.value) payload.daylight_rule = dst.control.value;
              if (sync.changed() && sync.control.value) payload.time_sync = sync.control.value;
              if (sntpMode.changed() && sntpMode.control.value) payload.sntp_mode = sntpMode.control.value;
              if (poll.changed() && poll.control.value !== '') payload.sntp_poll = Number(poll.control.value);
              if (sntpAuth.changed() && sntpAuth.control.value) payload.sntp_auth = sntpAuth.control.value === '1';
              if (timepMode.changed() && timepMode.control.value) {
                payload.timep_mode = timepMode.control.value;
                if (timepMode.control.value === 'manual') payload.timep_server = timepServer.value.trim();
              }
              const servers = sntpInput.value.split(',').map((s) => s.trim()).filter(Boolean);
              if (servers.length) payload.sntp_servers = servers;
              if (!Object.keys(payload).length) { toast('Nothing changed.', 'info'); return; }
              propose('system.set', payload).then((ok) => ok && refresh());
            },
          }),
        ),
        structured(logs.sntp),
      ]),
    ));

    // The status page as readable tiles: the headline facts first, then
    // whatever else this train reports. Raw stays collapsed underneath.
    const HEADLINE = [
      ['Name', info.name], ['Contact', info.contact], ['Location', info.location],
      ['Firmware', info.software], ['ROM', info.rom], ['Serial number', info.serial],
      ['Base MAC', info.base_mac], ['Uptime', info.uptime], ['CPU', info.cpu ? `${info.cpu} %` : ''],
      ['Memory total', info.mem_total], ['Memory free', info.mem_free],
      ['MAC age time', info.mac_age ? `${info.mac_age} s` : ''], ['Time zone', info.time_zone],
    ];
    const shown = new Set([
      'System Name', 'System Contact', 'System Location', 'Software revision',
      'ROM Version', 'Serial Number', 'Base MAC Addr', 'Up Time', 'CPU Util (%)',
      'MAC Age Time (sec)', 'Time Zone', 'Memory - Total', 'Free',
    ]);
    const rest = Object.entries(info.raw || {}).filter(([k]) => !shown.has(k));
    root.appendChild(card('System information', sys.info.command, [
      facts(HEADLINE, ['Base MAC', 'Serial number', 'Firmware', 'ROM', 'Memory total', 'Memory free']),
      rest.length ? facts(rest) : null,
      rawBlock(sys.info),
    ]));
  },
};

const logging = {
  id: 'logs',
  title: 'Syslog & debug',
  icon: '☰',
  group: 'System',

  async render(root, ctx) {
    const { data } = await api.data('logging');
    const refresh = () => ctx.reload();

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'Syslog & debug' }),
      h('p', { text: 'forwarding targets — the log itself lives under Status → Event log' }),
      h('span.spacer'),
      h('button.btn.btn-sm', {
        text: 'Open event log →',
        onclick: () => ctx.goto('events'),
      }),
    ));

    const serverInput = input({ placeholder: '10.0.0.9' });
    const facilitySel = select([
      ['', '— keep current —'], ...Array.from({ length: 8 }, (_, i) => [`local${i}`, `local${i}`]),
      ['kern', 'kern'], ['user', 'user'], ['daemon', 'daemon'], ['syslog', 'syslog'],
    ]);
    const sevSel = select([
      ['', '— keep current —'], ['debug', 'debug'], ['info', 'info'], ['warning', 'warning'],
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

    root.appendChild(structCard('Debug destinations', data.debug));
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

    root.appendChild(structCard('Queue configuration', data.queue));
    root.appendChild(structCard('Port priorities', data.port_priority));
    root.appendChild(structCard('DSCP mapping', data.dscp));
    root.appendChild(structCard('Device priority', data.device_priority));
    root.appendChild(structCard('Rate limits', data.rate_limit));
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
      rawBlock(data.config, 'Current ACL configuration (the editor source)'),
    ]));

    root.appendChild(structCard('ACL overview', data.list));
    root.appendChild(structCard('Assignment to ports / VLANs', data.ports));

    // ── hit counters ────────────────────────────────────────────────────
    const statName = input({ placeholder: 'ACL name or number', spellcheck: 'false' });
    const statTarget = input({ placeholder: 'port 5   ·   vlan 20 in', spellcheck: 'false' });
    const statHost = h('div');
    root.appendChild(card('ACL statistics', 'show statistics aclv4 …', [
      h('div.toolbar', null,
        statName, statTarget,
        h('button.btn.btn-primary.btn-sm', {
          text: 'Load counters',
          onclick: async () => {
            if (!statName.value.trim() || !statTarget.value.trim()) {
              toast('Enter the ACL and where it is applied.', 'err'); return;
            }
            statHost.replaceChildren(loading('Loading counters …'));
            try {
              const fetch = await api.showCmd(
                `show statistics aclv4 ${statName.value.trim()} ${statTarget.value.trim()}`, 30,
              );
              statHost.replaceChildren(structured(fetch));
            } catch (err) {
              statHost.replaceChildren(h('p.note', { text: `Failed: ${err.message}` }));
            }
          },
        }),
      ),
      statHost,
    ]));
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
