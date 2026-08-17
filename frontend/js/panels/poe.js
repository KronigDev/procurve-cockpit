// PoE — only mounted when the switch actually reports a PoE subsystem.

import { api } from '../api.js';
import { propose } from '../changes.js';
import { badge, card, field, h, input, rawBlock, rawCard, select, table, toast } from '../ui.js';

export default {
  id: 'poe',
  title: 'PoE',
  icon: '⚡',
  group: 'Configuration',
  requires: (caps) => !!caps.poe,

  async render(root, ctx) {
    const { data } = await api.data('poe');
    const refresh = () => ctx.reload();
    const ports = data.brief.data || [];
    const delivering = ports.filter((p) => parseFloat(p.actual || '0') > 0);
    const totalWatts = ports.reduce((sum, p) => sum + (parseFloat(p.actual) || 0), 0);

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'Power over Ethernet' }),
      h('p', { text: `${delivering.length} consumers · ${totalWatts.toFixed(1)} W total` }),
    ));

    root.appendChild(card('PoE ports', data.brief.command, [
      table([
        { key: 'port', label: 'Port', mono: true },
        {
          key: 'enabled',
          label: 'PoE',
          render: (p) => badge(p.enabled ? 'on' : 'off', p.enabled ? 'ok' : 'mute'),
        },
        { key: 'priority', label: 'Priority' },
        { key: 'class', label: 'Class' },
        { key: 'alloc_by', label: 'Allocation' },
        { key: 'alloc', label: 'Reserved', num: true },
        { key: 'actual', label: 'Draw', num: true },
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
    const prioSel = select([['', 'unchanged'], ['critical', 'critical'], ['high', 'high'], ['low', 'low']]);
    const allocSel = select([['', 'unchanged'], ['usage', 'usage'], ['class', 'class'], ['value', 'value']]);
    const maxInput = input({ type: 'number', placeholder: 'max watts (optional)' });

    const chosen = () => [...portPicker.selectedOptions].map((o) => o.value);

    root.appendChild(card('Configure PoE', null, [
      h('div.grid.cols-2', null,
        field('Ports', portPicker),
        h('div', null,
          field('Priority', prioSel),
          field('Allocation method', allocSel),
          field('Maximum power', maxInput),
          h('div.form-actions', null,
            h('button.btn.btn-primary', {
              text: 'Apply',
              onclick: () => {
                const sel = chosen();
                if (!sel.length) { toast('No ports selected.', 'err'); return; }
                const payload = { ports: sel };
                if (prioSel.value) payload.priority = prioSel.value;
                if (allocSel.value) payload.allocate_by = allocSel.value;
                if (maxInput.value !== '') payload.max_watts = Number(maxInput.value);
                if (Object.keys(payload).length === 1) { toast('Nothing changed.', 'info'); return; }
                propose('poe.set', payload).then((ok) => ok && refresh());
              },
            }),
            h('button.btn', {
              text: 'Power on',
              onclick: () => {
                const sel = chosen();
                if (!sel.length) { toast('No ports selected.', 'err'); return; }
                propose('poe.set', { ports: sel, enabled: true }).then((ok) => ok && refresh());
              },
            }),
            h('button.btn.btn-danger', {
              text: 'Power off',
              onclick: () => {
                const sel = chosen();
                if (!sel.length) { toast('No ports selected.', 'err'); return; }
                propose('poe.set', { ports: sel, enabled: false }).then((ok) => ok && refresh());
              },
            }),
          ),
          h('p.note', { text: 'Power off then on is the usual way to reboot a device remotely.' }),
        ),
      ),
    ]));

    root.appendChild(rawCard('PoE system status', data.summary));
  },
};
