// Stage → review → apply: config changes are collected locally and nothing
// reaches the switch until the pending set is applied from the top bar. Every
// change still shows its exact CLI before it is staged, and anything the
// backend flagged as `danger` needs a typed confirmation at apply time.
//
// Exec-level plans (reboot, image copy, TFTP) are the exception: they apply
// immediately with their own confirmation — batching a reboot makes no sense.

import { api, state } from './api.js';
import { closeModal, h, openModal, setBusy, setStatus, toast } from './ui.js';

/** Extra facts the backend risk analysis uses (management VLAN / IP). */
export const changeContext = { management_vlan: null, management_ip: null };

let onAppliedCallback = () => {};
export function onApplied(fn) { onAppliedCallback = fn; }

// ── the pending change set ────────────────────────────────────────────

const pending = [];
let onPendingChangedCallback = () => {};
export function onPendingChanged(fn) { onPendingChangedCallback = fn; }
export function pendingCount() { return pending.length; }

/** Hard reset — used on session boundaries so a staged batch can never be
 *  applied to a different switch than it was built for. */
export function clearPending() {
  if (!pending.length) return;
  pending.length = 0;
  pendingChanged();
}

function pendingChanged() { onPendingChangedCallback(pending.length); }

/**
 * Build a plan for an intent and show it. Resolves truthy when the action was
 * accepted — `'staged'` for a config plan added to the pending set (the
 * switch is untouched; a refresh just re-reads current state), `true` for an
 * exec plan that actually applied — and `false` on cancel/failure.
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
  if (plan.exec_level) return showExecPlan(plan);
  return new Promise((resolve) => {
    const body = h('div', null,
      h('p.note', {
        text: `${plan.commands.length} command(s) will be staged — nothing reaches `
          + 'the switch until you apply the pending changes:',
      }),
      h('div.plan-cmds', null, plan.commands.map((cmd) => h('div', { text: cmd }))),
      (plan.notes || []).map((note) => h('p.note', { text: `ℹ ${note}` })),
      (plan.risks || []).map((risk) => h(`div.risk.${risk.level === 'danger' ? 'danger' : 'warn'}`, null,
        h('b', { text: risk.level === 'danger' ? '⚠ Critical:' : 'Note:' }),
        h('span', { text: risk.message }))),
      (plan.risks || []).some((r) => r.level === 'danger')
        ? h('p.note', { text: 'The typed confirmation is asked when the pending changes are applied.' })
        : null,
    );

    openModal(plan.title || 'Review change', body, [
      h('span.spacer'),
      h('button.btn.btn-ghost', { text: 'Cancel', onclick: () => { closeModal(); resolve(false); } }),
      h('button.btn.btn-primary', {
        text: 'Stage change',
        onclick: () => {
          pending.push(plan);
          pendingChanged();
          toast(`Staged — ${pending.length} pending change${pending.length === 1 ? '' : 's'}`, 'info');
          // Resolve BEFORE closing: closeModal() runs the onClose callback,
          // whose resolve(false) would otherwise win the race.
          resolve('staged');
          closeModal();
        },
      }),
    ], () => resolve(false));
  });
}

// ── review & apply the pending set ────────────────────────────────────

export function openPendingReview() {
  if (!pending.length) return;

  const body = h('div');
  const applyBtn = h('button.btn.btn-primary', { text: 'Apply to switch' });
  const applySaveBtn = h('button.btn.btn-save', { text: 'Apply & save' });
  let confirmInput = null;

  const gate = () => {
    const ok = !confirmInput || confirmInput.value.trim().toUpperCase() === 'APPLY';
    applyBtn.disabled = !ok;
    applySaveBtn.disabled = !ok;
  };

  // Rebuilt as a whole on every Remove, so the risk banners and the typed
  // confirmation always describe the set that is actually about to be sent.
  const rebuild = () => {
    const dangers = pending.flatMap((p) => (p.risks || []).filter((r) => r.level === 'danger'));
    const warns = pending.flatMap((p) => (p.risks || []).filter((r) => r.level !== 'danger'));
    const commandCount = pending.reduce((n, p) => n + p.commands.length, 0);

    body.replaceChildren(
      h('p.note', {
        text: `${pending.length} staged change(s) · ${commandCount} command(s). `
          + 'Each change is applied in configuration mode, in this order:',
      }),
      ...pending.map((p, index) => h('div.pending-change', null,
        h('div.pending-head', null,
          h('b', { text: p.title || `Change ${index + 1}` }),
          h('span.spacer'),
          h('button.btn.btn-sm', {
            text: 'Remove',
            onclick: () => {
              pending.splice(index, 1);
              pendingChanged();
              if (!pending.length) closeModal();
              else rebuild();
            },
          }),
        ),
        h('div.plan-cmds', null, p.commands.map((cmd) => h('div', { text: cmd }))),
      )),
      ...dangers.map((risk) => h('div.risk.danger', null,
        h('b', { text: '⚠ Critical:' }), h('span', { text: risk.message }))),
      ...warns.map((risk) => h('div.risk.warn', null,
        h('b', { text: 'Note:' }), h('span', { text: risk.message }))),
    );

    confirmInput = null;
    if (dangers.length) {
      confirmInput = h('input', { placeholder: 'APPLY', spellcheck: 'false' });
      confirmInput.addEventListener('input', gate);
      body.appendChild(h('div.confirm-box', null,
        h('label', { text: 'This set contains changes that can lock you out. Type APPLY to confirm:' }),
        confirmInput,
      ));
    }
    gate();
  };
  rebuild();

  const keepBtn = h('button.btn.btn-ghost', { text: 'Keep staging', onclick: closeModal });
  let applying = false;

  const run = async (save) => {
    if (applying) return;
    applying = true;
    applyBtn.disabled = true;
    applySaveBtn.disabled = true;
    keepBtn.disabled = true;
    // Freeze the modal: the per-change Remove buttons must not mutate the
    // batch while it is being sent.
    body.replaceChildren(h('div.loading', null,
      h('div.spinner'), h('span', { text: 'Applying changes …' })));
    setBusy(true);
    setStatus('Sending configuration …');

    // Snapshot the batch: staging/removing during the run cannot touch it,
    // and on a connection failure the un-applied remainder goes back on the
    // queue -- the change that was in flight included, since it may have
    // partially executed and needs the user's eyes.
    const batch = pending.splice(0, pending.length);
    pendingChanged();

    // One apply per staged change: each runs context-clean, so a raw block
    // that forgets an `exit` cannot corrupt the changes staged after it.
    const results = [];
    let allOk = true;
    let transportError = null;
    let index = 0;
    for (; index < batch.length; index += 1) {
      try {
        const result = await api.apply(batch[index].commands, false, false);
        results.push(...(result.results || []));
        if (!result.ok) allOk = false;
      } catch (err) {
        transportError = err;
        break;
      }
    }
    if (transportError) {
      pending.push(...batch.slice(index));
      pendingChanged();
    }

    let saved = null;
    // Mirror the backend's rule: a batch with rejected commands is never
    // written to startup config.
    const savedSkipped = save && (!allOk || !!transportError);
    if (save && !savedSkipped) {
      setStatus('write memory …');
      try {
        saved = await api.save();
      } catch (err) {
        saved = { ok: false, error: err.message };
      }
    }

    applying = false;
    setBusy(false);
    setStatus('');
    renderResult({ title: 'Pending changes' }, {
      results,
      ok: allOk && !transportError && (!saved || saved.ok),
      saved,
      savedSkipped,
      interrupted: transportError ? transportError.message : null,
      stillPending: pending.length,
    }, save);
    // Only a batch that actually changed something touches the unsaved
    // bookkeeping and re-renders the panel.
    if (results.some((r) => r.ok)) {
      onAppliedCallback({ saved: !!(saved && saved.ok) });
    }
  };

  applyBtn.addEventListener('click', () => run(false));
  applySaveBtn.addEventListener('click', () => run(true));

  openModal('Apply pending changes', body, [
    h('span.spacer'),
    keepBtn,
    applyBtn,
    applySaveBtn,
  ]);
}

export function discardPending() {
  if (!pending.length) return;
  const count = pending.length;
  openModal('Discard staged changes?', h('div', null,
    h('p.note', {
      text: `${count} staged change${count === 1 ? '' : 's'} will be thrown away. `
        + 'The switch was never touched by them.',
    }),
  ), [
    h('span.spacer'),
    h('button.btn.btn-ghost', { text: 'Keep them', onclick: closeModal }),
    h('button.btn.btn-danger', {
      text: 'Discard',
      onclick: () => {
        pending.length = 0;
        pendingChanged();
        closeModal();
        toast(`${count} staged change${count === 1 ? '' : 's'} discarded`, 'info');
      },
    }),
  ]);
}

// ── exec-level plans: immediate, with their own confirmation ──────────

function showExecPlan(plan) {
  return new Promise((resolve) => {
    const dangers = (plan.risks || []).filter((r) => r.level === 'danger');
    const warns = (plan.risks || []).filter((r) => r.level !== 'danger');

    const body = h('div', null,
      h('p.note', {
        text: `${plan.commands.length} command(s) will be run at manager (exec) level — immediately:`,
      }),
      h('div.plan-cmds', null, plan.commands.map((cmd) => h('div', { text: cmd }))),
      (plan.notes || []).map((note) => h('p.note', { text: `ℹ ${note}` })),
      // Staged config changes are local -- a reboot (or the forced re-login
      // after it) throws them away without ever applying them.
      pending.length
        ? h('div.risk.warn', null,
            h('b', { text: 'Note:' }),
            h('span', {
              text: `${pending.length} staged config change${pending.length === 1 ? '' : 's'} `
                + 'have NOT been applied. They are lost if the switch reboots — apply or '
                + 'discard them from the top bar first.',
            }))
        : null,
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
      setStatus('Sending command …');
      try {
        const result = await api.apply(plan.commands, save, true);
        renderResult(plan, result, save);
        // A rebooting switch cannot be re-queried, and a batch aborted by a
        // failed up-front save applied nothing -- neither may trigger the
        // callers' refresh or the unsaved-changes bookkeeping.
        const aborted = result.saved && !result.saved.ok && !(result.results || []).length;
        resolve(!result.rebooting && !aborted);
        if (!result.rebooting && !aborted) {
          onAppliedCallback({ saved: !!(result.saved && result.saved.ok) });
        }
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

// ── result rendering ──────────────────────────────────────────────────

function renderResult(plan, result, saved) {
  // Exec plans save first; a failed `write memory` aborts the whole batch.
  if (result.saved && !result.saved.ok && !(result.results || []).length) {
    openModal('✕ Save failed', h('div', null,
      h('p.note', { text: 'write memory failed, so no command was executed:' }),
      h('div.risk.danger', null,
        h('b', { text: 'Switch:' }),
        h('span', { text: result.saved.error || result.saved.output || 'unknown error' }),
      ),
    ), [
      h('span.spacer'),
      h('button.btn.btn-primary', { text: 'Close', onclick: closeModal }),
    ]);
    toast('write memory failed', 'err', result.saved.error || '', 8000);
    return;
  }
  if (result.rebooting) {
    // The session is over; anything still staged can never be applied to it.
    pending.length = 0;
    pendingChanged();
    openModal('↻ Switch is rebooting', h('div', null,
      h('p.note', {
        text: 'The command was sent and the switch dropped the session — that is the '
          + 'reboot happening. Give it 1–3 minutes, then log in again.',
      }),
      h('div.plan-cmds', null, (result.results || []).map((r) =>
        h('div', { class: 'result-ok', text: r.command }))),
      saved && result.saved
        ? h('p.note', { text: result.saved.ok ? '💾 write memory done before the reboot.' : `write memory: ${result.saved.error}` })
        : null,
    ), [
      h('span.spacer'),
      h('button.btn.btn-primary', { text: 'Back to login', onclick: () => location.reload() }),
    ]);
    toast('Switch is rebooting …', 'info');
    return;
  }
  const failed = (result.results || []).filter((r) => !r.ok);
  const saveFailed = result.saved && !result.saved.ok;

  // Say what actually happened -- "0 of N rejected" when only the save (or
  // the connection) failed would blame commands that all succeeded.
  let headline;
  let title;
  if (result.interrupted) {
    title = '✕ Apply interrupted';
    headline = `The connection failed after ${result.results.length} command(s): `
      + `${result.interrupted}. ${result.stillPending} change(s) stay staged.`;
  } else if (failed.length) {
    title = '✕ Partially failed';
    headline = `${failed.length} of ${result.results.length} commands were rejected.`;
  } else if (saveFailed) {
    title = '✕ Applied, but not saved';
    headline = `All ${result.results.length} commands were accepted, but write memory failed.`;
  } else {
    title = '✓ Applied';
    headline = `All ${result.results.length} commands were accepted.`;
  }

  const body = h('div', null,
    h('p.note', { text: headline }),
    h('div.plan-cmds', null, (result.results || []).flatMap((r) => [
      h('div', { class: r.ok ? 'result-ok' : 'result-err', text: r.command }),
      r.error ? h('div.out', { text: r.error }) : null,
      !r.error && r.output ? h('div.out', { text: r.output.slice(0, 600) }) : null,
    ])),
    saved && result.saved
      ? h('p.note', { text: result.saved.ok ? '💾 write memory done.' : `write memory: ${result.saved.error}` })
      : null,
    result.savedSkipped
      ? h('p.note', { text: 'write memory was skipped because not everything applied cleanly.' })
      : null,
    !saved && result.ok
      ? h('p.note', { text: 'Not saved yet — a reboot would discard this change.' })
      : null,
  );

  openModal(title, body, [
    h('span.spacer'),
    h('button.btn.btn-primary', { text: 'Close', onclick: closeModal }),
  ]);

  if (result.ok) toast(saved ? 'Applied and saved' : 'Applied', 'ok');
  else if (result.interrupted) toast('Apply interrupted', 'err', result.interrupted, 8000);
  else if (failed.length) toast('Switch rejected commands', 'err', failed[0]?.error || '', 8000);
  else if (saveFailed) toast('Applied, but write memory failed', 'err', result.saved.error || '', 8000);
  else toast('Apply failed', 'err', '', 6000);
}

// ── one-off helpers ───────────────────────────────────────────────────

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
    // savedOnly: a bare write memory changes nothing a panel displays, so
    // the app must not re-render (that would wipe half-typed forms).
    onAppliedCallback({ saved: result.ok, savedOnly: true });
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
