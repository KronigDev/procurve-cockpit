// Landing panel: the numbers you want before touching anything.

import { api, state } from '../api.js';
import { faceplate, legend } from '../faceplate.js';
import { bytesToMb, card, formatUptime, h, kv, rawBlock, stat, table } from '../ui.js';

export default {
  id: 'dashboard',
  title: 'Übersicht',
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
        disabled ? `${disabled} deaktiviert` : 'keine deaktiviert',
        up ? 'ok' : ''),
      stat('Uptime', formatUptime(sys.uptime_seconds) || info.uptime || '—', info.uptime || ''),
      stat('CPU', Number.isFinite(cpu) ? `${cpu} %` : (info.cpu || '—'), 'Auslastung',
        cpu > 80 ? 'danger' : cpu > 50 ? 'warn' : 'ok'),
      stat('Speicher', memUsedPct !== null ? `${memUsedPct} %` : '—',
        memTotal ? `${Math.round(memTotal)} MB gesamt` : '',
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
    root.appendChild(card('Frontblende', 'Klick öffnet die Port-Verwaltung', fp));

    root.appendChild(h('div.grid.cols-2', null,
      card('System', sys.info.command, [
        kv([
          ['Name', info.name],
          ['Modell', sys.capabilities?.model],
          ['Firmware', info.software],
          ['ROM', info.rom],
          ['Seriennummer', info.serial],
          ['Basis-MAC', info.base_mac],
          ['Standort', info.location],
          ['Kontakt', info.contact],
          ['MAC-Age-Time', info.mac_age ? `${info.mac_age} s` : ''],
          ['Zeitzone', info.time_zone],
        ]),
        rawBlock(sys.info),
        rawBlock(sys.version),
      ]),
      card('Fähigkeiten', 'automatisch erkannt', [
        kv([
          ['Ports erkannt', sys.capabilities?.port_count],
          ['PoE', sys.capabilities?.poe ? 'ja' : 'nein'],
          ['IP-Routing verfügbar', sys.capabilities?.routing ? 'ja' : 'nein'],
          ['LLDP', sys.capabilities?.lldp ? 'ja' : 'nein'],
          ['Stacking', sys.capabilities?.stacking ? 'ja' : 'nein'],
        ]),
        (sys.capabilities?.modules || []).length
          ? table(
              [
                { key: 'slot', label: 'Slot' },
                { key: 'description', label: 'Modul' },
                { key: 'serial', label: 'Serial', mono: true },
                { key: 'status', label: 'Status' },
              ],
              sys.capabilities.modules,
            )
          : h('p.note', { text: 'Keine Erweiterungsmodule gemeldet.' }),
        rawBlock(sys.flash, 'Rohausgabe: show flash'),
      ]),
    ));

    // Log is slow on these boxes — load it after the page is already usable.
    const logCard = card('Letzte Ereignisse', 'show logging -r', h('div.loading', null,
      h('div.spinner'), h('span', { text: 'Lade Log …' })));
    root.appendChild(logCard);
    api.data('logging').then(({ data }) => {
      const body = logCard.querySelector('.card-body');
      body.replaceChildren(h('pre.raw', {
        text: (data.log?.raw || '(leer)').split('\n').slice(0, 200).join('\n'),
      }));
    }).catch((err) => {
      logCard.querySelector('.card-body').replaceChildren(
        h('p.note', { text: `Log konnte nicht geladen werden: ${err.message}` }));
    });
  },
};
