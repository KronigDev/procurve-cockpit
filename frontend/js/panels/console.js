// The escape hatch: a live CLI on the same session the panels use, so anything
// this UI does not model is still one command away.

import { state } from '../api.js';
import { h, toast } from '../ui.js';
import { downloadText } from './system.js';

const history = [];
let transcript = '';

const QUICK = [
  'show version', 'show system-information', 'show interfaces brief',
  'show vlans', 'show trunks', 'show spanning-tree', 'show lldp info remote-device',
  'show mac-address', 'show arp', 'show ip', 'show running-config', 'show logging -r',
  'show tech', 'show flash', 'show modules',
];

export default {
  id: 'console',
  title: 'CLI console',
  icon: '›_',
  group: 'System',

  async render(root) {
    root.appendChild(h('div.page-head', null,
      h('h2', { text: 'CLI console' }),
      h('p', { text: 'Direct access to the same SSH session — anything the switch can do works here.' }),
    ));

    const out = h('div.console-out');
    const promptLabel = h('span', { text: '#' });
    const line = h('input', {
      placeholder: 'Type a command … (↑/↓ for history; the switch does not do tab completion)',
      spellcheck: 'false', autocomplete: 'off',
    });

    const write = (text, cls = '') => {
      out.appendChild(h('div', { class: cls, text }));
      transcript += text + '\n';
      out.scrollTop = out.scrollHeight;
    };

    // Quick command chips.
    const quickBar = h('div.toolbar');
    for (const cmd of QUICK) {
      quickBar.appendChild(h('button.btn.btn-sm', {
        text: cmd,
        onclick: () => { line.value = cmd; send(); },
      }));
    }
    quickBar.appendChild(h('span.spacer'));
    quickBar.appendChild(h('button.btn.btn-sm', {
      text: 'Save transcript',
      onclick: () => downloadText('cli-transcript.txt', transcript),
    }));
    quickBar.appendChild(h('button.btn.btn-sm', {
      text: 'Clear',
      onclick: () => { out.replaceChildren(); transcript = ''; },
    }));

    root.appendChild(quickBar);
    root.appendChild(h('div.console', null,
      out,
      h('div.console-in', null, promptLabel, line),
    ));

    // ── websocket ───────────────────────────────────────────────────
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/cli?token=${encodeURIComponent(state.token)}`);
    let ready = false;

    ws.addEventListener('open', () => { ready = true; write('* connected', 'c-sys'); });
    ws.addEventListener('close', () => { ready = false; write('* console connection closed', 'c-sys'); });
    ws.addEventListener('error', () => write('* console socket error', 'c-err'));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'prompt') {
        promptLabel.textContent = msg.prompt || '#';
      } else if (msg.type === 'echo') {
        write(`${promptLabel.textContent} ${msg.command}`, 'c-cmd');
      } else if (msg.type === 'output') {
        if (msg.output) write(msg.output);
        if (msg.error) write(msg.error, 'c-err');
        if (msg.prompt) promptLabel.textContent = msg.prompt;
        line.disabled = false;
        line.focus();
      } else if (msg.type === 'error') {
        write(msg.message, 'c-err');
        line.disabled = false;
      }
    });

    const send = () => {
      const command = line.value.trim();
      if (!command) return;
      if (!ready) { toast('Console not connected.', 'err'); return; }
      history.push(command);
      historyIndex = history.length;
      line.value = '';
      line.disabled = true;
      ws.send(JSON.stringify({ command }));
    };

    let historyIndex = history.length;
    line.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); send(); }
      else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        if (historyIndex > 0) { historyIndex -= 1; line.value = history[historyIndex]; }
      } else if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        if (historyIndex < history.length - 1) { historyIndex += 1; line.value = history[historyIndex]; }
        else { historyIndex = history.length; line.value = ''; }
      }
    });

    setTimeout(() => line.focus(), 50);

    write('ProCurve Cockpit — CLI. Use the panels for configuration changes so the preview '
        + 'applies. Commands typed here run immediately.', 'c-sys');

    // Tear the socket down when the panel is replaced.
    return () => { try { ws.close(); } catch { /* already gone */ } };
  },
};
