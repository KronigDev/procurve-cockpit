// Landing panel: the numbers you want before touching anything.

import { api, state } from '../api.js';
import { faceplate, legend } from '../faceplate.js';
import { badge, bytesToMb, card, formatUptime, h, kv, rawBlock, stat, table } from '../ui.js';
import { sevBadge } from './events.js';

export default {
  id: 'dashboard',
  title: 'Overview',
  icon: '▤',
  group: 'Status',

  async render(root, ctx) {
    const [{ data: sys }, { data: ports }] = await Promise.all([
      api.data('system'),
      api.data('ports'),
    ]);

    const info = sys.info.data || {};
    const list = ports.ports || [];
    const up = list.filter((p) => p.up).length;
    const disabled = list.filter((p) => p.enabled === false).length;

    const memTotal = bytesToMb(info.mem_total);
    const memFree = bytesToMb(info.mem_free);
    const memUsedPct = memTotal && memFree ? Math.round(((memTotal - memFree) / memTotal) * 100) : null;
    const cpu = parseInt(String(info.cpu).replace(/\D/g, ''), 10);

    root.appendChild(h('div.page-head', null,
      h('h2', { text: info.name || state.host }),
      h('p', { text: `${sys.capabilities?.model || 'ProVision'} · ${info.software || ''}` }),
    ));

    root.appendChild(h('div.grid.cols-4', null,
      stat('Ports up', `${up} / ${list.length}`,
        disabled ? `${disabled} disabled` : 'none disabled',
        up ? 'ok' : ''),
      stat('Uptime', formatUptime(sys.uptime_seconds) || info.uptime || '—', info.uptime || ''),
      stat('CPU', Number.isFinite(cpu) ? `${cpu} %` : (info.cpu || '—'), 'utilisation',
        cpu > 80 ? 'danger' : cpu > 50 ? 'warn' : 'ok'),
      stat('Memory', memUsedPct !== null ? `${memUsedPct} %` : '—',
        memTotal ? `${Math.round(memTotal)} MB total` : '',
        memUsedPct > 85 ? 'warn' : ''),
    ));

    // Faceplate — read only here; the Ports panel is where you act.
    const fp = h('div');
    fp.appendChild(faceplate(list, {
      selected: new Set(),
      colorBy: 'status',
      onToggle: () => ctx.goto('ports'),
    }));
    fp.appendChild(legend('status'));
    root.appendChild(card('Front panel', 'click opens port management', fp));

    root.appendChild(h('div.grid.cols-2', null,
      card('System', sys.info.command, [
        kv([
          ['Name', info.name],
          ['Model', sys.capabilities?.model],
          ['Firmware', info.software],
          ['ROM', info.rom],
          ['Serial number', info.serial],
          ['Base MAC', info.base_mac],
          ['Location', info.location],
          ['Contact', info.contact],
          ['MAC age time', info.mac_age ? `${info.mac_age} s` : ''],
          ['Time zone', info.time_zone],
        ]),
        rawBlock(sys.info),
        rawBlock(sys.version),
        // Resource fallbacks (only fetched when the status page lacks them) —
        // their raw output is the first thing to look at when a tile is empty.
        sys.resources?.cpu ? rawBlock(sys.resources.cpu) : null,
        sys.resources?.memory ? rawBlock(sys.resources.memory) : null,
        sys.resources?.uptime ? rawBlock(sys.resources.uptime) : null,
      ]),
      card('Capabilities', 'auto-detected', [
        kv([
          ['Ports detected', sys.capabilities?.port_count],
          ['PoE', sys.capabilities?.poe ? 'yes' : 'no'],
          ['IP routing available', sys.capabilities?.routing ? 'yes' : 'no'],
          ['LLDP', sys.capabilities?.lldp ? 'yes' : 'no'],
          ['Stacking', sys.capabilities?.stacking ? 'yes' : 'no'],
        ]),
        (sys.capabilities?.modules || []).length
          ? table(
              [
                { key: 'slot', label: 'Slot' },
                { key: 'description', label: 'Module' },
                { key: 'serial', label: 'Serial', mono: true },
                { key: 'status', label: 'Status' },
              ],
              sys.capabilities.modules,
            )
          : h('p.note', { text: 'No expansion modules reported.' }),
      ]),
    ));

    // ── flash & boot ────────────────────────────────────────────────────
    const flash = sys.flash.data || {};
    const ver = sys.version.data || {};
    const images = flash.images || [];
    root.appendChild(card('Flash & boot', sys.flash.command, [
      images.length
        ? table([
            {
              key: 'slot', label: 'Image',
              render: (r) => h('span', null,
                h('b', { text: r.slot }), ' ',
                r.slot === ver.boot_image ? badge('running', 'ok') : null, ' ',
                r.slot === flash.default_boot ? badge('default boot', 'info') : null,
              ),
            },
            { key: 'version', label: 'Version', mono: true },
            { key: 'date', label: 'Date', mono: true },
            {
              key: 'size_bytes', label: 'Size', num: true,
              render: (r) => {
                const mbVal = bytesToMb(r.size_bytes);
                return mbVal ? `${mbVal.toFixed(1)} MB` : '—';
              },
            },
          ], images)
        : h('p.note', { text: 'Could not parse the flash listing — raw output below.' }),
      kv([
        ['Boot ROM', flash.boot_rom],
        ['Default boot', flash.default_boot],
        ['Running image', ver.boot_image],
        ['Build date', ver.build_date],
      ]),
      h('div.form-actions', null,
        h('button.btn.btn-sm', {
          text: 'Manage firmware & boot →',
          onclick: () => ctx.goto('firmware'),
        }),
      ),
      rawBlock(sys.flash),
    ]));

    // Log is slow on these boxes — load it after the page is already usable.
    const logCard = card('Recent events', 'show logging -r', h('div.loading', null,
      h('div.spinner'), h('span', { text: 'Loading log …' })));
    root.appendChild(logCard);
    api.data('logging').then(({ data }) => {
      const body = logCard.querySelector('.card-body');
      const entries = (data.log?.data || []).slice(0, 15);
      if (entries.length) {
        body.replaceChildren(
          table([
            { key: 'severity', label: 'Sev', render: sevBadge },
            { key: 'date', label: 'Date', mono: true },
            { key: 'time', label: 'Time', mono: true },
            { key: 'module', label: 'System', mono: true },
            { key: 'message', label: 'Event' },
          ], entries),
          h('div.form-actions', null,
            h('button.btn.btn-sm', {
              text: 'Full event log with filters →',
              onclick: () => ctx.goto('events'),
            }),
          ),
        );
      } else {
        body.replaceChildren(h('pre.raw', {
          text: (data.log?.raw || '(empty)').split('\n').slice(0, 200).join('\n'),
        }));
      }
    }).catch((err) => {
      logCard.querySelector('.card-body').replaceChildren(
        h('p.note', { text: `Could not load the log: ${err.message}` }));
    });
  },
};
