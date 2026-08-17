// VLANs: the list, a per-VLAN editor, and a click-to-edit membership matrix.
// The matrix collects every change locally and emits one batch of CLI at the
// end, so a 24-port re-layout is a single reviewable plan.

import { api } from '../api.js';
import { propose } from '../changes.js';
import { vlanColor } from '../faceplate.js';
import {
  badge, card, checkbox, field, h, input, rawBlock, select, table, toast,
} from '../ui.js';

const pending = new Map(); // "port|vid" -> 'u' | 't' | 'f' | ''

export default {
  id: 'vlans',
  title: 'VLANs',
  icon: '⧉',
  group: 'Konfiguration',

  async render(root, ctx) {
    const [{ data: vlanData }, { data: portData }, { data: routing }] = await Promise.all([
      api.data('vlans'),
      api.data('ports'),
      api.data('routing'),
    ]);
    const vlans = vlanData.vlans || [];
    const ports = (portData.ports || []).filter((p) => !/^trk/i.test(p.port));
    const ipByVlan = new Map((routing.ip.data || []).map((row) => [String(row.vlan), row]));
    const refresh = () => ctx.reload();

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'VLANs' }),
      h('p', { text: `${vlans.length} VLANs konfiguriert` }),
      h('span.spacer'),
      h('button.btn.btn-primary', { text: '+ VLAN anlegen', onclick: () => createDialog(refresh) }),
    ));

    // ── overview table ────────────────────────────────────────────────
    const rows = vlans.map((v) => {
      const untagged = v.ports.filter((p) => p.mode.startsWith('untag')).map((p) => p.port);
      const tagged = v.ports.filter((p) => p.mode.startsWith('tag')).map((p) => p.port);
      const ip = ipByVlan.get(String(v.id));
      return { ...v, untaggedPorts: untagged, taggedPorts: tagged, ipRow: ip };
    });

    root.appendChild(card('Konfigurierte VLANs', vlanData.source?.command, [
      table([
        {
          key: 'id',
          label: 'ID',
          render: (v) => h('span', null,
            h('i', {
              style: {
                display: 'inline-block', width: '9px', height: '9px', borderRadius: '2px',
                background: vlanColor(v.id), marginRight: '7px',
              },
            }),
            String(v.id)),
        },
        { key: 'name', label: 'Name' },
        {
          key: 'role',
          label: 'Rolle',
          render: (v) => h('span', null,
            v.primary ? badge('primary', 'info') : null,
            v.is_mgmt ? badge('management', 'violet') : null,
          ),
        },
        {
          key: 'ip',
          label: 'IP',
          mono: true,
          render: (v) => v.ipRow
            ? (v.ipRow.ip ? `${v.ipRow.ip} ${v.ipRow.mask || ''}` : v.ipRow.config)
            : '',
        },
        {
          key: 'untaggedPorts',
          label: 'Untagged',
          mono: true,
          render: (v) => v.untaggedPorts.join(',') || '',
        },
        {
          key: 'taggedPorts',
          label: 'Tagged',
          mono: true,
          render: (v) => v.taggedPorts.join(',') || '',
        },
        { key: 'jumbo', label: 'Jumbo', render: (v) => (v.jumbo ? 'ja' : '') },
        { key: 'voice', label: 'Voice', render: (v) => (v.voice ? 'ja' : '') },
        {
          key: 'edit',
          label: '',
          render: (v) => h('button.btn.btn-sm', {
            text: 'Bearbeiten',
            onclick: (ev) => { ev.stopPropagation(); editDialog(v, refresh); },
          }),
        },
      ], rows),
      rawBlock(vlanData.source),
    ], null, true));

    // ── membership matrix ─────────────────────────────────────────────
    pending.clear();
    const current = new Map();
    for (const vlan of vlans) {
      for (const entry of vlan.ports) {
        const mode = entry.mode.startsWith('untag') ? 'u'
          : entry.mode.startsWith('tag') ? 't'
          : entry.mode.startsWith('forbid') ? 'f' : '';
        if (mode) current.set(`${entry.port}|${vlan.id}`, mode);
      }
    }

    const matrixHost = h('div.matrix-wrap');
    const applyBar = h('div.toolbar');

    const stateOf = (port, vid) => {
      const key = `${port}|${vid}`;
      return pending.has(key) ? pending.get(key) : (current.get(key) || '');
    };

    const drawMatrix = () => {
      const head = h('tr', null,
        h('th.corner', { text: 'Port' }),
        ...vlans.map((v) => h('th.vh', null, h('div', { text: `${v.id} · ${v.name}` }))),
      );
      const body = h('tbody');
      for (const port of ports) {
        const tr = h('tr', null, h('th.ph', { text: port.port }));
        for (const vlan of vlans) {
          const key = `${port.port}|${vlan.id}`;
          const value = stateOf(port.port, vlan.id);
          const cell = h('td', {
            class: `${value}${pending.has(key) ? ' changed' : ''}`.trim(),
            text: value ? value.toUpperCase() : '·',
            title: `Port ${port.port} / VLAN ${vlan.id} — Klick: untagged → tagged → keine`,
            onclick: () => {
              const next = { '': 'u', u: 't', t: '', f: '' }[stateOf(port.port, vlan.id)];
              const original = current.get(key) || '';
              if (next === original) pending.delete(key); else pending.set(key, next);
              drawMatrix();
            },
          });
          tr.appendChild(cell);
        }
        body.appendChild(tr);
      }
      matrixHost.replaceChildren(h('table.matrix', null, h('thead', null, head), body));

      applyBar.replaceChildren(
        h('span.muted', {
          text: pending.size
            ? `${pending.size} Änderung(en) vorgemerkt`
            : 'Zellen anklicken, um Zuordnungen zu ändern.',
        }),
        h('span.spacer'),
        h('button.btn.btn-sm', {
          text: 'Verwerfen',
          disabled: !pending.size,
          onclick: () => { pending.clear(); drawMatrix(); },
        }),
        h('button.btn.btn-primary.btn-sm', {
          text: 'Änderungen anwenden',
          disabled: !pending.size,
          onclick: () => {
            const lines = matrixCommands(current, pending);
            if (!lines.length) { toast('Keine Änderungen.', 'info'); return; }
            propose('raw', { lines }).then((ok) => { if (ok) { pending.clear(); refresh(); } });
          },
        }),
      );
    };
    drawMatrix();

    root.appendChild(card('Zuordnungsmatrix', 'U = untagged · T = tagged',
      [applyBar, matrixHost], null, false));
  },
};

/**
 * Translate matrix edits into CLI, grouped per VLAN so one VLAN context does
 * all its adds and removes together.
 */
function matrixCommands(current, changes) {
  const perVlan = new Map(); // vid -> {untag:[], tag:[], noUntag:[], noTag:[]}
  const bucket = (vid) => {
    if (!perVlan.has(vid)) perVlan.set(vid, { untag: [], tag: [], remove: [] });
    return perVlan.get(vid);
  };

  for (const [key, next] of changes) {
    const [port, vidText] = key.split('|');
    const vid = Number(vidText);
    const before = current.get(key) || '';
    if (next === before) continue;
    if (next === 'u') bucket(vid).untag.push(port);
    else if (next === 't') bucket(vid).tag.push(port);
    else if (next === 'f') bucket(vid).remove.push(port); // handled as plain removal
    else bucket(vid).remove.push(port);
  }

  const lines = [];
  // Removals first: a port must leave its old untagged VLAN before it can join
  // a new one, otherwise ProVision rejects the second membership.
  for (const [vid, ops] of perVlan) {
    if (!ops.remove.length) continue;
    lines.push(`vlan ${vid}`);
    lines.push(`no untagged ${ops.remove.join(',')}`);
    lines.push(`no tagged ${ops.remove.join(',')}`);
    lines.push('exit');
  }
  for (const [vid, ops] of perVlan) {
    if (!ops.untag.length && !ops.tag.length) continue;
    lines.push(`vlan ${vid}`);
    if (ops.untag.length) lines.push(`untagged ${ops.untag.join(',')}`);
    if (ops.tag.length) lines.push(`tagged ${ops.tag.join(',')}`);
    lines.push('exit');
  }
  return lines;
}

function createDialog(refresh) {
  const idInput = input({ type: 'number', min: 2, max: 4094, placeholder: '20' });
  const nameInput = input({ placeholder: 'z. B. Gaeste' });
  const ipInput = input({ placeholder: '192.168.20.1/24 oder leer' });
  const jumbo = checkbox('Jumbo Frames', false);
  const voice = checkbox('Voice VLAN', false);

  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
    field('VLAN-ID', idInput),
    field('Name', nameInput),
    field('IP-Adresse', ipInput, '(optional, CIDR)'),
    jumbo.el, voice.el,
  );

  import('../ui.js').then(({ openModal, closeModal }) => {
    openModal('VLAN anlegen', body, [
      h('span.spacer'),
      h('button.btn.btn-ghost', { text: 'Abbrechen', onclick: closeModal }),
      h('button.btn.btn-primary', {
        text: 'Weiter',
        onclick: () => {
          closeModal();
          propose('vlan.create', {
            id: Number(idInput.value),
            name: nameInput.value,
            ip: ipInput.value || undefined,
            jumbo: jumbo.input.checked,
            voice: voice.input.checked,
          }).then((ok) => ok && refresh());
        },
      }),
    ]);
  });
}

function editDialog(vlan, refresh) {
  const nameInput = input({ value: vlan.name || '' });
  const ipMode = select([['keep', 'unverändert'], ['static', 'statische IP'], ['dhcp', 'DHCP/BootP'], ['none', 'keine IP']]);
  const ipInput = input({ placeholder: '192.168.10.1/24' });
  const jumbo = checkbox('Jumbo Frames', vlan.jumbo);
  const voice = checkbox('Voice VLAN', vlan.voice);
  const helperInput = input({ placeholder: 'DHCP-Relay-Ziel, z. B. 10.0.0.5' });

  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
    h('div.chip', { text: `VLAN ${vlan.id}` }),
    field('Name', nameInput),
    field('IP-Konfiguration', ipMode),
    field('IP-Adresse', ipInput, '(nur bei statisch)'),
    field('IP Helper-Address', helperInput, '(DHCP-Relay)'),
    jumbo.el, voice.el,
    h('div.form-actions', null,
      h('button.btn.btn-sm', {
        text: 'Als Primary-VLAN setzen',
        onclick: () => propose('vlan.role', { id: vlan.id, role: 'primary' }).then((ok) => ok && refresh()),
      }),
      h('button.btn.btn-sm', {
        text: 'Als Management-VLAN setzen',
        onclick: () => propose('vlan.role', { id: vlan.id, role: 'management' }).then((ok) => ok && refresh()),
      }),
    ),
  );

  import('../ui.js').then(({ openModal, closeModal }) => {
    openModal(`VLAN ${vlan.id} bearbeiten`, body, [
      h('button.btn.btn-danger', {
        text: 'VLAN löschen',
        onclick: () => { closeModal(); propose('vlan.delete', { id: vlan.id }).then((ok) => ok && refresh()); },
      }),
      h('span.spacer'),
      h('button.btn.btn-ghost', { text: 'Abbrechen', onclick: closeModal }),
      h('button.btn.btn-primary', {
        text: 'Weiter',
        onclick: () => {
          const payload = { id: vlan.id };
          if (nameInput.value !== vlan.name) payload.name = nameInput.value;
          if (ipMode.value === 'static') payload.ip = ipInput.value;
          else if (ipMode.value === 'dhcp') payload.ip = 'dhcp';
          else if (ipMode.value === 'none') payload.ip = '';
          if (jumbo.input.checked !== vlan.jumbo) payload.jumbo = jumbo.input.checked;
          if (voice.input.checked !== vlan.voice) payload.voice = voice.input.checked;
          if (helperInput.value) payload.helper_address = helperInput.value;
          closeModal();
          propose('vlan.update', payload).then((ok) => ok && refresh());
        },
      }),
    ]);
  });
}
