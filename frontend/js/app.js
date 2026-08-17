// App shell: login, navigation, panel lifecycle.

import { api, state } from './api.js';
import {
  changeContext, clearPending, discardPending, onApplied, onPendingChanged,
  openPendingReview, pendingCount, writeMemory,
} from './changes.js';
import {
  bytesToMb, formatUptime, h, loading, setBusy, setStatus, toast,
} from './ui.js';

import dashboard from './panels/dashboard.js';
import events from './panels/events.js';
import extras from './panels/extras.js';
import firmware from './panels/firmware.js';
import ports from './panels/ports.js';
import protocols from './panels/protocols.js';
import vlans from './panels/vlans.js';
import switching from './panels/switching.js';
import network from './panels/network.js';
import poe from './panels/poe.js';
import security from './panels/security.js';
import systemPanels from './panels/system.js';
import config from './panels/config.js';
import consolePanel from './panels/console.js';

const PANELS = [
  dashboard,
  events,
  ports,
  vlans,
  ...switching,
  poe,
  protocols,
  ...network,
  ...security,
  ...systemPanels,
  extras,
  firmware,
  config,
  consolePanel,
];

const GROUP_ORDER = ['Status', 'Configuration', 'Security', 'Diagnostics', 'System'];

let current = null;
let cleanup = null;
let unsaved = false;

// ── login ─────────────────────────────────────────────────────────────

const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const loginBtn = document.getElementById('login-btn');

loginForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = new FormData(loginForm);
  const payload = {
    host: String(form.get('host') || '').trim(),
    username: String(form.get('username') || '').trim() || 'manager',
    password: String(form.get('password') || ''),
    enable_password: String(form.get('enable_password') || ''),
    transport: String(form.get('transport') || 'ssh'),
    legacy: form.get('legacy') !== null,
  };
  const port = String(form.get('port') || '').trim();
  if (port) payload.port = Number(port);

  loginError.hidden = true;
  loginBtn.disabled = true;
  loginBtn.textContent = 'Connecting …';
  try {
    const result = await api.connect(payload);
    state.token = result.token;
    state.host = result.host;
    state.system = result.system;
    state.caps = result.system.capabilities || {};
    state.hostKey = result.host_key;
    startApp();
  } catch (err) {
    loginError.hidden = false;
    loginError.textContent = err.message;
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Connect';
  }
});

// ── app startup ───────────────────────────────────────────────────────

function startApp() {
  document.getElementById('login').hidden = true;
  document.getElementById('app').hidden = false;
  // A fresh session starts clean: staged changes from a previous session
  // belong to a different switch/login and must never carry over.
  clearPending();
  setUnsaved(false);
  buildNav();
  updateTopbar();
  loadManagementContext();
  goto(location.hash.replace('#', '') || 'dashboard');

  if (state.hostKey) {
    toast('Connected', 'ok', `Host key ${state.hostKey.type}\n${state.hostKey.sha256}`, 7000);
  }
}

/** Tell the risk analysis which VLAN/IP carries this session. */
async function loadManagementContext() {
  changeContext.management_ip = state.host;
  try {
    const [{ data: vlanData }, { data: routing }] = await Promise.all([
      api.data('vlans'), api.data('routing'),
    ]);
    const vlanList = vlanData.vlans || [];
    const explicit = vlanList.find((v) => v.is_mgmt);
    if (explicit) { changeContext.management_vlan = explicit.id; return; }
    // `show ip` labels rows with the VLAN *name*, not its id, so resolve it.
    const match = (routing.ip.data || []).find((row) => row.ip && row.ip === state.host);
    if (!match) return;
    const byName = vlanList.find((v) => v.name === match.vlan);
    changeContext.management_vlan = byName ? byName.id : (Number(match.vlan) || null);
  } catch {
    // Non-fatal: risk analysis simply stays generic.
  }
}

function buildNav() {
  const nav = document.getElementById('sidenav');
  nav.replaceChildren();
  const available = PANELS.filter((p) => !p.requires || p.requires(state.caps));
  for (const group of GROUP_ORDER) {
    const inGroup = available.filter((p) => p.group === group);
    if (!inGroup.length) continue;
    nav.appendChild(h('div.nav-group', { text: group }));
    for (const panel of inGroup) {
      nav.appendChild(h('button.nav-item', {
        dataset: { panel: panel.id },
        onclick: () => goto(panel.id),
      },
        h('span.nav-ico', { text: panel.icon || '•' }),
        h('span', { text: panel.title }),
      ));
    }
  }
}

function updateTopbar() {
  const info = state.system?.info?.data || {};
  document.getElementById('sw-name').textContent = info.name || state.host || '—';
  document.getElementById('sw-sub').textContent =
    `${state.host}${state.caps.model ? ` · ${state.caps.model}` : ''}`;
  document.getElementById('status-model').textContent =
    `${info.software || ''} ${info.serial ? `· SN ${info.serial}` : ''}`;

  const memTotal = bytesToMb(info.mem_total);
  const memFree = bytesToMb(info.mem_free);
  const stats = document.getElementById('topbar-stats');
  stats.replaceChildren(
    tstat(formatUptime(state.system?.uptime_seconds) || info.uptime || '—', 'Uptime'),
    tstat(info.cpu ? `${String(info.cpu).replace(/\D/g, '')} %` : '—', 'CPU'),
    tstat(memTotal && memFree
      ? `${Math.round(((memTotal - memFree) / memTotal) * 100)} %`
      : '—', 'Memory'),
    tstat(String(state.caps.port_count || '—'), 'Ports'),
  );
}

function tstat(value, label) {
  return h('div.tstat', null, h('b', { text: value }), h('span', { text: label }));
}

// ── panel routing ─────────────────────────────────────────────────────

async function goto(id) {
  const panel = PANELS.find((p) => p.id === id)
    || PANELS.find((p) => p.id === 'dashboard');
  if (!panel) return;
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  current = panel;
  location.hash = panel.id;

  for (const item of document.querySelectorAll('.nav-item')) {
    item.classList.toggle('active', item.dataset.panel === panel.id);
  }

  const main = document.getElementById('main');
  main.replaceChildren(loading(`Loading ${panel.title} …`));
  setBusy(true);
  setStatus(`${panel.title} …`);

  const host = h('div');
  try {
    const result = await panel.render(host, { reload: () => goto(panel.id), goto });
    if (typeof result === 'function') cleanup = result;
    main.replaceChildren(host);
    main.scrollTop = 0;
  } catch (err) {
    main.replaceChildren(h('div.card', null, h('div.card-body', null,
      h('div.risk.danger', null,
        h('b', { text: 'Error:' }),
        h('span', { text: err.message }),
      ),
      h('p.note', {
        text: err.status === 401
          ? 'The session expired. Please connect again.'
          : 'The switch did not answer as expected. The CLI console shows what really comes back.',
      }),
      h('div.form-actions', null,
        h('button.btn', { text: 'Retry', onclick: () => goto(panel.id) }),
        h('button.btn', { text: 'Open CLI console', onclick: () => goto('console') }),
      ),
    )));
    if (err.status === 401) showLogin();
  } finally {
    setBusy(false);
    setStatus('');
    refreshStatusPrompt();
  }
}

async function refreshStatusPrompt() {
  try {
    const info = await api.status();
    document.getElementById('status-prompt').textContent = info.prompt || '—';
  } catch {
    document.getElementById('status-prompt').textContent = '—';
  }
}

function showLogin() {
  state.token = null;
  clearPending();
  setUnsaved(false);
  document.getElementById('app').hidden = true;
  document.getElementById('login').hidden = false;
}

// ── topbar actions ────────────────────────────────────────────────────

document.getElementById('btn-refresh').addEventListener('click', () => current && goto(current.id));
document.getElementById('btn-save').addEventListener('click', () => writeMemory());
document.getElementById('btn-disconnect').addEventListener('click', async () => {
  if (pendingCount()
    && !window.confirm(`${pendingCount()} staged change(s) were never applied and will be lost. Disconnect anyway?`)) {
    return;
  }
  try { await api.disconnect(); } catch { /* session may already be gone */ }
  showLogin();
});

// Staged changes live only in this tab — closing or reloading loses them.
window.addEventListener('beforeunload', (ev) => {
  if (pendingCount()) { ev.preventDefault(); ev.returnValue = ''; }
});

// ── staged changes ────────────────────────────────────────────────────
document.getElementById('btn-pending').addEventListener('click', openPendingReview);
document.getElementById('btn-discard').addEventListener('click', discardPending);
onPendingChanged((count) => {
  document.getElementById('pending-box').hidden = !count;
  document.getElementById('btn-pending').textContent =
    `${count} pending change${count === 1 ? '' : 's'} …`;
});

function setUnsaved(value) {
  unsaved = value;
  document.getElementById('unsaved-badge').hidden = !value;
  // The Save button only exists while there is something to save.
  document.getElementById('btn-save').hidden = !value;
}

// Any applied change without an immediate save leaves the switch dirty --
// and the current panel shows pre-apply state, so re-render it.  `saved`
// arrives true when the apply already included `write memory`; `savedOnly`
// marks a bare write memory, which changes nothing a panel shows and must
// not wipe half-typed forms with a re-render.
onApplied(({ saved, savedOnly } = {}) => {
  if (savedOnly) {
    if (saved) setUnsaved(false);
    return;
  }
  setUnsaved(!saved);
  if (current) goto(current.id);
});

document.addEventListener('keydown', (ev) => {
  if (ev.target.matches('input, textarea, select')) return;
  // No global shortcuts while a modal is up -- 'r' would re-render the panel
  // behind the review, Ctrl+S would write memory mid-decision.
  if (!document.getElementById('modal').hidden) return;
  if (ev.key === 'r' && !ev.ctrlKey && !ev.metaKey) { ev.preventDefault(); current && goto(current.id); }
  if (ev.key === 's' && (ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault();
    writeMemory();
  }
});

window.addEventListener('hashchange', () => {
  const id = location.hash.replace('#', '');
  if (id && current && id !== current.id) goto(id);
});
