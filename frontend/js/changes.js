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
    toast('Cannot build that change', 'err', err.message, 6000);
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
      h('p.note', { text: `${plan.commands.length} command(s) will be sent in configuration mode:` }),
      h('div.plan-cmds', null, plan.commands.map((cmd) => h('div', { text: cmd }))),
      (plan.notes || []).map((note) => h('p.note', { text: `ℹ ${note}` })),
      dangers.map((risk) => h('div.risk.danger', null,
        h('b', { text: '⚠ Critical:' }), h('span', { text: risk.message }))),
      warns.map((risk) => h('div.risk.warn', null,
        h('b', { text: 'Note:' }), h('span', { text: risk.message }))),
    );

    let confirmInput = null;
    if (dangers.length) {
      confirmInput = h('input', { placeholder: 'APPLY', spellcheck: 'false' });
      body.appendChild(h('div.confirm-box', null,
        h('label', { text: 'This change can lock you out. Type APPLY to confirm:' }),
        confirmInput,
      ));
    }

    const applyBtn = h('button.btn.btn-primary', { text: 'Apply' });
    const applySaveBtn = h('button.btn.btn-save', { text: 'Apply & save' });

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
      setStatus('Sending configuration …');
      try {
        const result = await api.apply(plan.commands, save);
        renderResult(plan, result, save);
        resolve(true);
        onAppliedCallback();
      } catch (err) {
        toast('Apply failed', 'err', err.message, 8000);
        gate();
        resolve(false);
      } finally {
        setBusy(false);
        setStatus('');
      }
    };

    applyBtn.addEventListener('click', () => run(false));
    applySaveBtn.addEventListener('click', () => run(true));

    openModal(plan.title || 'Review change', body, [
      h('span.spacer'),
      h('button.btn.btn-ghost', { text: 'Cancel', onclick: () => { closeModal(); resolve(false); } }),
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
        ? `All ${result.results.length} commands were accepted.`
        : `${failed.length} of ${result.results.length} commands were rejected.`,
    }),
    h('div.plan-cmds', null, (result.results || []).flatMap((r) => [
      h('div', { class: r.ok ? 'result-ok' : 'result-err', text: r.command }),
      r.error ? h('div.out', { text: r.error }) : null,
      !r.error && r.output ? h('div.out', { text: r.output.slice(0, 600) }) : null,
    ])),
    saved && result.saved
      ? h('p.note', { text: result.saved.ok ? '💾 write memory done.' : `write memory: ${result.saved.error}` })
      : null,
    !saved && result.ok
      ? h('p.note', { text: 'Not saved yet — a reboot would discard this change.' })
      : null,
  );

  openModal(result.ok ? '✓ Applied' : '✕ Partially failed', body, [
    h('span.spacer'),
    h('button.btn.btn-primary', { text: 'Close', onclick: closeModal }),
  ]);

  if (result.ok) toast(saved ? 'Applied and saved' : 'Applied', 'ok');
  else toast('Switch rejected commands', 'err', failed[0]?.error || '', 8000);
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
    if (result.ok) toast('Configuration saved', 'ok');
    else toast('Save failed', 'err', result.error || '');
    onAppliedCallback();
    return result.ok;
  } catch (err) {
    toast('Save failed', 'err', err.message);
    return false;
  } finally {
    setBusy(false);
    setStatus('');
  }
}

export { state };
