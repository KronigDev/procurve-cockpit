// Flash images, default boot, reboots and TFTP firmware updates.

import { api } from '../api.js';
import { propose } from '../changes.js';
import {
  badge, card, field, h, input, rawBlock, select, stat, structCard, table, toast,
} from '../ui.js';

function mb(bytes) {
  const num = Number(bytes);
  if (!Number.isFinite(num) || num <= 0) return '—';
  return `${(num / (1024 * 1024)).toFixed(1)} MB`;
}

export default {
  id: 'firmware',
  title: 'Firmware & boot',
  icon: '⇈',
  group: 'System',

  async render(root, ctx) {
    const { data } = await api.data('firmware');
    const flash = data.flash.data || {};
    const ver = data.version.data || {};
    const images = flash.images || [];
    const running = ver.boot_image || '';
    const defBoot = flash.default_boot || '';

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'Firmware & boot' }),
      h('p', {
        text: ver.version
          ? `running ${ver.version}${running ? ` from the ${running} image` : ''}`
          : 'flash images, boot selection, reboot',
      }),
    ));

    root.appendChild(h('div.grid.cols-3', null,
      stat('Running image', running || '—', ver.version || '', 'ok'),
      stat('Default boot', defBoot || '—', 'used at the next reboot',
        defBoot && running && defBoot !== running ? 'warn' : ''),
      stat('Boot ROM', flash.boot_rom || '—', ver.build_date || ''),
    ));

    // ── flash images ────────────────────────────────────────────────────
    // Exec plans apply immediately; the global onApplied hook re-renders the
    // panel afterwards, so no local refresh chain is needed.
    const act = (intent, payload) => propose(intent, payload);

    const imageTable = table([
      {
        key: 'slot', label: 'Image',
        render: (r) => h('span', null,
          h('b', { text: r.slot }), ' ',
          r.slot === running ? badge('running', 'ok') : null, ' ',
          r.slot === defBoot ? badge('default boot', 'info') : null,
        ),
      },
      { key: 'version', label: 'Version', mono: true },
      { key: 'date', label: 'Date', mono: true },
      { key: 'size_bytes', label: 'Size', num: true, render: (r) => mb(r.size_bytes) },
      {
        key: 'actions', label: '',
        render: (r) => h('div.form-actions', null,
          r.slot !== defBoot
            ? h('button.btn.btn-sm', {
                text: 'Set as default',
                title: 'boot set-default flash — takes effect at the next reboot',
                onclick: () => act('firmware.default_boot', { image: r.slot }),
              })
            : null,
          h('button.btn.btn-sm', {
            text: 'Boot now …',
            title: `boot system flash ${r.slot} — reboots the switch`,
            onclick: () => act('firmware.boot', { image: r.slot }),
          }),
          r.slot !== running
            ? h('button.btn.btn-sm.btn-danger', {
                text: 'Erase …',
                onclick: () => act('firmware.erase', { image: r.slot }),
              })
            : null,
        ),
      },
    ], images, { emptyText: 'Could not parse the flash listing — raw output below.' });

    root.appendChild(card('Flash images', data.flash.command, [
      imageTable,
      h('div.form-actions', null,
        h('button.btn', {
          text: 'Copy primary → secondary',
          title: 'copy flash flash secondary',
          onclick: () => act('firmware.copy', { to: 'secondary' }),
        }),
        h('button.btn', {
          text: 'Copy secondary → primary',
          title: 'copy flash flash primary',
          onclick: () => act('firmware.copy', { to: 'primary' }),
        }),
      ),
      rawBlock(data.flash),
      rawBlock(data.version),
    ]));

    // ── reboot & tftp update ────────────────────────────────────────────
    const minutesInput = input({ type: 'number', min: 1, placeholder: '10', style: { maxWidth: '110px' } });
    const atInput = input({ placeholder: '23:15', style: { maxWidth: '110px' } });
    const dateInput = input({ placeholder: 'MM/DD/YY (optional)', style: { maxWidth: '150px' } });

    const serverInput = input({ placeholder: '192.168.1.50' });
    const fileInput = input({ placeholder: 'W_15_14_0012.swi', spellcheck: 'false' });
    const targetSel = select([['secondary', 'secondary'], ['primary', 'primary']]);

    root.appendChild(h('div.grid.cols-2', null,
      card('Reboot', 'reload / boot', [
        h('p.note', { text: `Reboots from the default image (${defBoot || 'primary'}). Every session drops.` }),
        h('div.form-actions', null,
          h('button.btn.btn-danger', {
            text: 'Reboot now …',
            onclick: () => act('firmware.reload', { mode: 'now' }),
          }),
        ),
        field('Scheduled reboot', h('div.form-actions', null,
          minutesInput,
          h('button.btn.btn-sm', {
            text: 'Reboot in N minutes',
            onclick: () => {
              if (!minutesInput.value) { toast('Enter the minutes.', 'err'); return; }
              act('firmware.reload', { mode: 'after', minutes: Number(minutesInput.value) });
            },
          }),
        ), '(reload after)'),
        field('Reboot at a fixed time', h('div.form-actions', null,
          atInput, dateInput,
          h('button.btn.btn-sm', {
            text: 'Schedule',
            onclick: () => {
              if (!atInput.value) { toast('Enter a time like 23:15.', 'err'); return; }
              act('firmware.reload', { mode: 'at', time: atInput.value.trim(), date: dateInput.value.trim() });
            },
          }),
        ), '(reload at)'),
        h('div.form-actions', null,
          h('button.btn', {
            text: 'Cancel scheduled reboot',
            title: 'reload cancel',
            onclick: () => act('firmware.reload', { mode: 'cancel' }),
          }),
        ),
      ]),
      card('Firmware update via TFTP', 'copy tftp flash', [
        field('TFTP server', serverInput),
        field('File name', fileInput, '(.swi image on the TFTP server)'),
        field('Write to image', targetSel),
        h('p.note', {
          text: 'Transfer plus flashing takes several minutes and blocks the CLI. '
            + 'Afterwards set the image as default boot (or boot it directly) above.',
        }),
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Download to switch …',
            onclick: () => {
              if (!serverInput.value.trim() || !fileInput.value.trim()) {
                toast('Server and file name are required.', 'err'); return;
              }
              act('firmware.download', {
                server: serverInput.value.trim(),
                filename: fileInput.value.trim(),
                image: targetSel.value,
              });
            },
          }),
        ),
      ]),
    ));

    // Not every train knows these commands; hide them instead of showing errors.
    if (!data.boot_history.error && (data.boot_history.raw || '').trim()) {
      root.appendChild(structCard('Boot history', data.boot_history));
    }
    if (!data.config_files.error && (data.config_files.raw || '').trim()) {
      root.appendChild(structCard('Startup config files', data.config_files));
    }
  },
};
