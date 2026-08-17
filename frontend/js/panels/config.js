// Configuration: running vs startup, backup, restore, and the reboot controls.

import { api, state } from '../api.js';
import { execCommand, propose, writeMemory } from '../changes.js';
import {
  badge, card, checkbox, closeModal, h, openModal, rawBlock, toast,
} from '../ui.js';
import { downloadText } from './system.js';

export default {
  id: 'config',
  title: 'Konfiguration',
  icon: '⎘',
  group: 'System',

  async render(root, ctx) {
    const { data } = await api.data('config');
    const refresh = () => ctx.reload();

    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'Konfiguration' }),
      h('p', { text: `${data.running.length} Zeilen running-config` }),
      h('span.spacer'),
      data.unsaved
        ? badge('running ≠ startup', 'warn')
        : badge('running = startup', 'ok'),
    ));

    // ── diff ─────────────────────────────────────────────────────────
    const diffNodes = (data.diff || []).map((line) =>
      h('div', { class: line.kind, text: line.text }));
    root.appendChild(card('Unterschied startup → running', null, [
      data.diff && data.diff.length
        ? h('div.diff', null, diffNodes)
        : h('p.note', { text: 'Running- und Startup-Konfiguration sind identisch.' }),
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
      placeholder: 'Konfigurationszeilen hier einfügen oder eine Datei wählen …',
      style: { minHeight: '180px' },
    });
    const fileInput = h('input', {
      type: 'file', accept: '.cfg,.txt,.conf',
      onchange: async (ev) => {
        const file = ev.target.files[0];
        if (!file) return;
        uploadArea.value = await file.text();
        toast(`${file.name} geladen (${uploadArea.value.split('\n').length} Zeilen)`, 'info');
      },
    });
    const saveAfter = checkbox('Nach dem Übertragen speichern (write memory)', false);

    root.appendChild(h('div.grid.cols-2', null,
      card('Sicherung', null, [
        h('p.note', { text: 'Lädt die aktuelle running-config als Textdatei herunter.' }),
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'running-config herunterladen',
            onclick: () => {
              const name = `${(state.system?.info?.data?.name || 'switch')}-${stamp()}.cfg`;
              downloadText(name, data.running.join('\n') + '\n');
            },
          }),
          h('button.btn', {
            text: 'startup-config herunterladen',
            onclick: () => {
              const name = `${(state.system?.info?.data?.name || 'switch')}-startup-${stamp()}.cfg`;
              downloadText(name, data.startup.join('\n') + '\n');
            },
          }),
        ),
      ]),
      card('Wiederherstellen / Zeilen einspielen', null, [
        h('div.form-actions', null, fileInput),
        uploadArea,
        saveAfter.el,
        h('div.form-actions', null,
          h('button.btn.btn-primary', {
            text: 'Vorschau & Übertragen',
            onclick: () => {
              const lines = uploadArea.value.split('\n')
                .map((l) => l.replace(/\s+$/, ''))
                .filter((l) => l.trim() && !l.trim().startsWith(';'));
              if (!lines.length) { toast('Keine Zeilen zum Übertragen.', 'err'); return; }
              propose('raw', { lines }).then((ok) => ok && refresh());
            },
          }),
        ),
        h('p.note', {
          text: 'ProVision kennt kein atomares "config replace". Die Zeilen werden in die '
              + 'laufende Konfiguration eingemischt — vorhandene Einstellungen, die in der Datei '
              + 'fehlen, bleiben bestehen.',
        }),
      ]),
    ));

    // ── running config viewer ────────────────────────────────────────
    root.appendChild(card('running-config', 'show running-config', [
      h('pre.raw', { text: data.running.join('\n'), style: { maxHeight: '60vh' } }),
    ]));

    // ── dangerous operations ─────────────────────────────────────────
    root.appendChild(card('Neustart & Zurücksetzen', null, [
      h('div.form-actions', null,
        h('button.btn.btn-danger', {
          text: 'Switch neu starten (reload)',
          onclick: () => confirmDangerous(
            'Switch neu starten?',
            'Der Switch startet neu. Nicht gespeicherte Änderungen gehen verloren, die '
              + 'Verbindung bricht ab und alle Ports sind für ca. eine Minute tot.',
            'reload',
            refresh,
          ),
        }),
        h('button.btn.btn-danger', {
          text: 'Werkszustand (erase startup-config)',
          onclick: () => confirmDangerous(
            'Startup-Konfiguration löschen?',
            'Nach dem nächsten Neustart hat der Switch Werkseinstellungen — inklusive '
              + 'verlorener IP-Adresse. Danach ist nur noch die serielle Konsole sicher erreichbar.',
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
  const goBtn = h('button.btn.btn-danger', { text: 'Ausführen', disabled: true });
  confirmInput.addEventListener('input', () => {
    goBtn.disabled = confirmInput.value.trim() !== command;
  });
  goBtn.addEventListener('click', async () => {
    goBtn.disabled = true;
    closeModal();
    try {
      const result = await execCommand(command, 30);
      toast(result.ok ? `"${command}" gesendet` : 'Switch hat abgelehnt', result.ok ? 'ok' : 'err',
        result.error || result.output?.slice(0, 200) || '');
    } catch (err) {
      // A reload legitimately kills the session mid-command.
      toast('Verbindung beendet — vermutlich startet der Switch neu.', 'info', err.message);
    }
    after();
  });

  openModal(title, h('div', null,
    h('div.risk.danger', null, h('b', { text: '⚠' }), h('span', { text: warning })),
    h('div.confirm-box', null,
      h('label', { text: `Tippe zur Bestätigung exakt: ${command}` }),
      confirmInput,
    ),
  ), [
    h('span.spacer'),
    h('button.btn.btn-ghost', { text: 'Abbrechen', onclick: closeModal }),
    goBtn,
  ]);
}
