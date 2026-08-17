// PoE — only mounted when the switch actually reports a PoE subsystem.

import { api } from '../api.js';
import { propose } from '../changes.js';
import { badge, card, field, h, input, rawBlock, rawCard, select, table, toast } from '../ui.js';

export default {
  id: 'poe',
  title: 'PoE',
  icon: '⚡',
  group: 'Konfiguration',
  requires: (caps) => !!caps.poe,

  async render(root, ctx) {
    const { data } = await api.data('poe');
    const refresh = () => ctx.reload();
    const ports = data.brief.data || [];
    const delivering = ports.filter((p) => parseFloat(p.actual || '0') > 0);
    const totalWatts = ports.reduce((sum, p) => sum + (parseFloat(p.actual) || 0), 0);

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'Power over Ethernet' }),
      h('p', { text: `${delivering.length} Verbraucher · ${totalWatts.toFixed(1)} W gesamt` }),
    ));

    root.appendChild(card('PoE-Ports', data.brief.command, [
      table([
        { key: 'port', label: 'Port', mono: true },
        {
          key: 'enabled',
          label: 'PoE',
          render: (p) => badge(p.enabled ? 'ein' : 'aus', p.enabled ? 'ok' : 'mute'),
        },
        { key: 'priority', label: 'Priorität' },
        { key: 'class', label: 'Klasse' },
        { key: 'alloc_by', label: 'Zuteilung' },
        { key: 'alloc', label: 'Reserviert', num: true },
        { key: 'actual', label: 'Verbrauch', num: true },
        { key: 'status', label: 'Status' },
      ], ports),
      rawBlock(data.brief),
    ], null, true));

    const portPicker = h('select', { multiple: true, size: 10, style: { height: 'auto' } });
    for (const port of ports) {
      portPicker.appendChild(h('option', {
        value: port.port, text: `${port.port} — ${port.status || ''} ${port.actual || ''}`,
      }));
    }
    const prioSel = select([['', 'unverändert'], ['critical', 'critical'], ['high', 'high'], ['low', 'low']]);
    const allocSel = select([['', 'unverändert'], ['usage', 'usage'], ['class', 'class'], ['value', 'value']]);
    const maxInput = input({ type: 'number', placeholder: 'max. Watt (optional)' });

    const chosen = () => [...portPicker.selectedOptions].map((o) => o.value);

    root.appendChild(card('PoE konfigurieren', null, [
      h('div.grid.cols-2', null,
        field('Ports', portPicker),
        h('div', null,
          field('Priorität', prioSel),
          field('Zuteilungsmethode', allocSel),
          field('Maximale Leistung', maxInput),
          h('div.form-actions', null,
            h('button.btn.btn-primary', {
              text: 'Übernehmen',
              onclick: () => {
                const sel = chosen();
                if (!sel.length) { toast('Keine Ports gewählt.', 'err'); return; }
                const payload = { ports: sel };
                if (prioSel.value) payload.priority = prioSel.value;
                if (allocSel.value) payload.allocate_by = allocSel.value;
                if (maxInput.value !== '') payload.max_watts = Number(maxInput.value);
                if (Object.keys(payload).length === 1) { toast('Nichts geändert.', 'info'); return; }
                propose('poe.set', payload).then((ok) => ok && refresh());
              },
            }),
            h('button.btn', {
              text: 'PoE einschalten',
              onclick: () => {
                const sel = chosen();
                if (!sel.length) { toast('Keine Ports gewählt.', 'err'); return; }
                propose('poe.set', { ports: sel, enabled: true }).then((ok) => ok && refresh());
              },
            }),
            h('button.btn.btn-danger', {
              text: 'PoE ausschalten',
              onclick: () => {
                const sel = chosen();
                if (!sel.length) { toast('Keine Ports gewählt.', 'err'); return; }
                propose('poe.set', { ports: sel, enabled: false }).then((ok) => ok && refresh());
              },
            }),
          ),
          h('p.note', { text: 'PoE aus/ein ist der übliche Weg, ein Gerät per Fernzugriff neu zu starten.' }),
        ),
      ),
    ]));

    root.appendChild(rawCard('PoE-Gesamtstatus', data.summary));
  },
};
