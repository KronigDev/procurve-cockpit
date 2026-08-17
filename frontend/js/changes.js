// Preview → Apply: nothing reaches the switch before the exact CLI has been
// shown. Anything the backend flagged as `danger` additionally needs a typed
// confirmation, because those are the commands that end the session.

import { api, state } from './api.js';
import { closeModal, h, openModal, setBusy, setStatus, toast } from './ui.js';

/** Extra facts the backend risk analysis uses (management VLAN / IP). */
export const changeContext = { management_vlan: null, management_ip: null };

let onAppliedCallback = () => {};
export function onApplied(fn) { onAppliedCallback = fn; }

/**
 * Build a plan for an intent and show it. Returns a promise that resolves to
 * true when something was actually applied.
 */
export async function propose(intent, payload) {
  let plan;
  try {
    plan = await api.plan(intent, { ...payload, context: { ...changeContext } });
  } catch (err) {
    toast('Änderung nicht möglich', 'err', err.message, 6000);
    return false;
  }
  return showPlan(plan);
}

/** Show a plan the caller already built (raw config lines, config upload, …). */
export function proposeCommands(title, commands, notes = []) {
  return showPlan({ title, commands, notes, risks: [], exec_level: false });
}

function showPlan(plan) {
  return new Promise((resolve) => {
    const dangers = (plan.risks || []).filter((r) => r.level === 'danger');
    const warns = (plan.risks || []).filter((r) => r.level !== 'danger');

    const body = h('div', null,
      h('p.note', { text: `${plan.commands.length} Befehl(e) werden im Konfigurationsmodus gesendet:` }),
      h('div.plan-cmds', null, plan.commands.map((cmd) => h('div', { text: cmd }))),
      (plan.notes || []).map((note) => h('p.note', { text: `ℹ ${note}` })),
      dangers.map((risk) => h('div.risk.danger', null,
        h('b', { text: '⚠ Kritisch:' }), h('span', { text: risk.message }))),
      warns.map((risk) => h('div.risk.warn', null,
        h('b', { text: 'Hinweis:' }), h('span', { text: risk.message }))),
    );

    let confirmInput = null;
    if (dangers.length) {
      confirmInput = h('input', { placeholder: 'APPLY', spellcheck: 'false' });
      body.appendChild(h('div.confirm-box', null,
        h('label', { text: 'Diese Änderung kann dich aussperren. Tippe APPLY zum Bestätigen:' }),
        confirmInput,
      ));
    }

    const applyBtn = h('button.btn.btn-primary', { text: 'Anwenden' });
    const applySaveBtn = h('button.btn.btn-save', { text: 'Anwenden & Speichern' });

    const gate = () => {
      const ok = !confirmInput || confirmInput.value.trim().toUpperCase() === 'APPLY';
      applyBtn.disabled = !ok;
      applySaveBtn.disabled = !ok;
    };
    if (confirmInput) confirmInput.addEventListener('input', gate);
    gate();

    const run = async (save) => {
      applyBtn.disabled = true;
      applySaveBtn.disabled = true;
      setBusy(true);
      setStatus('Sende Konfiguration …');
      try {
        const result = await api.apply(plan.commands, save);
        renderResult(plan, result, save);
        resolve(true);
        onAppliedCallback();
      } catch (err) {
        toast('Anwenden fehlgeschlagen', 'err', err.message, 8000);
        gate();
        resolve(false);
      } finally {
        setBusy(false);
        setStatus('');
      }
    };

    applyBtn.addEventListener('click', () => run(false));
    applySaveBtn.addEventListener('click', () => run(true));

    openModal(plan.title || 'Änderung prüfen', body, [
      h('span.spacer'),
      h('button.btn.btn-ghost', { text: 'Abbrechen', onclick: () => { closeModal(); resolve(false); } }),
      applyBtn,
      applySaveBtn,
    ], () => resolve(false));
  });
}

function renderResult(plan, result, saved) {
  const failed = (result.results || []).filter((r) => !r.ok);
  const body = h('div', null,
    h('p.note', {
      text: result.ok
        ? `Alle ${result.results.length} Befehle wurden angenommen.`
        : `${failed.length} von ${result.results.length} Befehlen wurden abgelehnt.`,
    }),
    h('div.plan-cmds', null, (result.results || []).flatMap((r) => [
      h('div', { class: r.ok ? 'result-ok' : 'result-err', text: r.command }),
      r.error ? h('div.out', { text: r.error }) : null,
      !r.error && r.output ? h('div.out', { text: r.output.slice(0, 600) }) : null,
    ])),
    saved && result.saved
      ? h('p.note', { text: result.saved.ok ? '💾 write memory ausgeführt.' : `write memory: ${result.saved.error}` })
      : null,
    !saved && result.ok
      ? h('p.note', { text: 'Noch nicht gespeichert — bei einem Neustart geht die Änderung verloren.' })
      : null,
  );

  openModal(result.ok ? '✓ Angewendet' : '✕ Teilweise fehlgeschlagen', body, [
    h('span.spacer'),
    h('button.btn.btn-primary', { text: 'Schließen', onclick: closeModal }),
  ]);

  if (result.ok) toast(saved ? 'Angewendet und gespeichert' : 'Angewendet', 'ok');
  else toast('Switch hat Befehle abgelehnt', 'err', failed[0]?.error || '', 8000);
}

/** Used by the console + config panels for single exec-level commands. */
export async function execCommand(command, timeout = 60) {
  setBusy(true);
  try {
    return await api.exec(command, timeout);
  } finally {
    setBusy(false);
  }
}

export async function writeMemory() {
  setBusy(true);
  setStatus('write memory …');
  try {
    const result = await api.save();
    if (result.ok) toast('Konfiguration gespeichert', 'ok');
    else toast('Speichern fehlgeschlagen', 'err', result.error || '');
    onAppliedCallback();
    return result.ok;
  } catch (err) {
    toast('Speichern fehlgeschlagen', 'err', err.message);
    return false;
  } finally {
    setBusy(false);
    setStatus('');
  }
}

export { state };
