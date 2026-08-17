// Configuration: running vs startup, backup, restore, and the reboot controls.

import { api, state } from '../api.js';
import { execCommand, propose, writeMemory } from '../changes.js';
import {
  badge, card, checkbox, closeModal, h, openModal, toast,
} from '../ui.js';
import { downloadText } from './system.js';

export default {
  id: 'config',
  title: 'Configuration',
  icon: '⎘',
  group: 'System',

  async render(root, ctx) {
    const { data } = await api.data('config');
    const refresh = () => ctx.reload();

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'Configuration' }),
      h('p', { text: `${data.running.length} lines of running-config` }),
      h('span.spacer'),
      data.unsaved
        ? badge('running ≠ startup', 'warn')
        : badge('running = startup', 'ok'),
    ));

    // ── diff ─────────────────────────────────────────────────────────
    const diffNodes = (data.diff || []).map((line) =>
      h('div', { class: line.kind, text: line.text }));
    root.appendChild(card('Difference startup → running', null, [
      data.diff && data.diff.length
        ? h('div.diff', null, diffNodes)
        : h('p.note', { text: 'Running and startup configuration are identical.' }),
      h('div.form-actions', null,
        h('button.btn.btn-save', {
          text: 'write memory (running → startup)',
          disabled: !data.unsaved,
          onclick: () => writeMemory().then(refresh),
        }),
      ),
    ]));

    // ── backup / restore ─────────────────────────────────────────────
    const uploadArea = h('textarea', {
      placeholder: 'Paste configuration lines here, or pick a file …',
      style: { minHeight: '180px' },
    });
    const fileInput = h('input', {
      type: 'file', accept: '.cfg,.txt,.conf',
      onchange: async (ev) => {
        const file = ev.target.files[0];
        if (!file) return;
        uploadArea.value = await file.text();
        toast(`${file.name} loaded (${uploadArea.value.split('\n').length} lines)`, 'info');
      },
    });
    const saveAfter = checkbox('Save after transfer (write memory)', false);

    root.appendChild(h('div.grid.cols-2', null,
      card('Backup', null, [
        h('p.note', { text: 'Downloads the current running-config as a text file.' }),
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Download running-config',
            onclick: () => {
              const name = `${(state.system?.info?.data?.name || 'switch')}-${stamp()}.cfg`;
              downloadText(name, data.running.join('\n') + '\n');
            },
          }),
          h('button.btn', {
            text: 'Download startup-config',
            onclick: () => {
              const name = `${(state.system?.info?.data?.name || 'switch')}-startup-${stamp()}.cfg`;
              downloadText(name, data.startup.join('\n') + '\n');
            },
          }),
        ),
      ]),
      card('Restore / push lines', null, [
        h('div.form-actions', null, fileInput),
        uploadArea,
        saveAfter.el,
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Preview & transfer',
            onclick: () => {
              const lines = uploadArea.value.split('\n')
                .map((l) => l.replace(/\s+$/, ''))
                .filter((l) => l.trim() && !l.trim().startsWith(';'));
              if (!lines.length) { toast('Nothing to transfer.', 'err'); return; }
              propose('raw', { lines }).then((ok) => ok && refresh());
            },
          }),
        ),
        h('p.note', {
          text: 'ProVision has no atomic "config replace". The lines are merged into the running '
              + 'configuration — existing settings that are missing from the file stay in place.',
        }),
      ]),
    ));

    // ── running config viewer ────────────────────────────────────────
    root.appendChild(card('running-config', 'show running-config', [
      h('pre.raw', { text: data.running.join('\n'), style: { maxHeight: '60vh' } }),
    ]));

    // ── dangerous operations ─────────────────────────────────────────
    root.appendChild(card('Reboot & reset', null, [
      h('div.form-actions', null,
        h('button.btn.btn-danger', {
          text: 'Reboot the switch (reload)',
          onclick: () => confirmDangerous(
            'Reboot the switch?',
            'The switch reboots. Unsaved changes are lost, this connection drops, and every '
              + 'port is dead for about a minute.',
            'reload',
            refresh,
          ),
        }),
        h('button.btn.btn-danger', {
          text: 'Factory reset (erase startup-config)',
          onclick: () => confirmDangerous(
            'Erase the startup configuration?',
            'After the next reboot the switch is back to factory defaults — including losing '
              + 'its IP address. Only the serial console is guaranteed to reach it after that.',
            'erase startup-config',
            refresh,
          ),
        }),
      ),
    ]));
  },
};

function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/**
 * These commands run at exec level (not inside `configure`), so they bypass the
 * normal plan flow and get their own typed confirmation.
 */
function confirmDangerous(title, warning, command, after) {
  const confirmInput = h('input', { placeholder: command, spellcheck: 'false' });
  const goBtn = h('button.btn.btn-danger', { text: 'Run', disabled: true });
  confirmInput.addEventListener('input', () => {
    goBtn.disabled = confirmInput.value.trim() !== command;
  });
  goBtn.addEventListener('click', async () => {
    goBtn.disabled = true;
    closeModal();
    try {
      const result = await execCommand(command, 30);
      toast(result.ok ? `"${command}" sent` : 'Switch refused', result.ok ? 'ok' : 'err',
        result.error || result.output?.slice(0, 200) || '');
    } catch (err) {
      // A reload legitimately kills the session mid-command.
      toast('Connection closed — the switch is probably rebooting.', 'info', err.message);
    }
    after();
  });

  openModal(title, h('div', null,
    h('div.risk.danger', null, h('b', { text: '⚠' }), h('span', { text: warning })),
    h('div.confirm-box', null,
      h('label', { text: `Type this exactly to confirm: ${command}` }),
      confirmInput,
    ),
  ), [
    h('span.spacer'),
    h('button.btn.btn-ghost', { text: 'Cancel', onclick: closeModal }),
    goBtn,
  ]);
}
