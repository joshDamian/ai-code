// An interactive shell in one of a task's directories, over xterm.js.
//
// The component owns an emulator and one WebSocket; it does not own the shell. The
// PTY, its scrollback and whether it is still running all live in the server
// (src/terminal.mjs), keyed by (task, directory), which is what makes a refresh in
// the middle of a `claude` session come back to the same session rather than a new
// one. So a remount here is a reattach, and nothing in this file has to decide when a
// shell should end.
import { html, useEffect, useRef, useState } from '../lib.mjs';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { terminalSocketUrl } from '../api.mjs';

// How long to wait before reattaching after an abnormal close - a bounced server, a
// dropped network. A deliberate close is not retried at all: 1000 means the shell
// itself exited, and reconnecting there would spawn a fresh shell every two seconds
// at a command that exits immediately.
const RETRY_MS = 2000;

const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';

// The emulator needs colours as values, not as the custom properties the rest of the
// stylesheet uses, so they are read off the document rather than repeated here:
// index.html stays the one place the palette is written down. Ansi black-through-white
// are left at xterm's defaults, which are tuned for a dark background already.
function palette() {
  const read = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  return {
    background: read('--bg', '#0a0c10'),
    foreground: read('--text', '#edf2f7'),
    cursor: read('--accent', '#9fb9ff'),
    cursorAccent: read('--bg', '#0a0c10'),
    selectionBackground: read('--accent-dim', '#4a6fa5'),
  };
}

// What the bar above the terminal says, by connection state. Connected is the one
// state with nothing to say - the shell's own output is the evidence - and it is an
// empty string rather than an absent bar so the terminal does not jump by a line
// every time the connection blinks.
const STATUS = {
  connecting: ['connecting…', ''],
  open: ['', ''],
  reconnecting: ['disconnected — reconnecting…', 'warn'],
  ended: ['the shell exited', 'warn'],
};

export function TerminalPane({ taskId, target }) {
  const hostRef = useRef(null);
  const [state, setState] = useState('connecting');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const term = new Terminal({
      fontFamily: MONO,
      fontSize: 12.5,
      cursorBlink: true,
      // History is the server's to keep (it replays its own on attach); this is only
      // how far back the wheel can scroll without asking it, which is a person's
      // memory of what they just read.
      scrollback: 5000,
      theme: palette(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    let ws = null;
    let retry = null;
    let closed = false;

    const send = (msg) => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
    };

    // The round trip that makes a full-screen program work: the emulator decides how
    // many rows fit in the box it has, the kernel has to be told, and claude, less or
    // vim redraws off the answer. Guarded on a non-zero box because this runs before
    // layout on the first frame, and a fit against a zero-width host produces a
    // terminal of NaN columns rather than a smaller one.
    const refit = () => {
      if (closed || !host.clientWidth || !host.clientHeight) return;
      fit.fit();
      send({ type: 'resize', cols: term.cols, rows: term.rows });
    };

    function connect() {
      ws = new WebSocket(terminalSocketUrl(taskId, target));
      // Sent on open rather than before it: the server's session may be one that
      // outlived this tab at a size the tab it was opened from chose, and the new
      // reader is the one that decides how wide the shell is now.
      ws.onopen = () => {
        setState('open');
        refit();
        term.focus();
      };
      ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : '');
      ws.onclose = (e) => {
        if (closed) return;
        // 1000 is the server saying the shell ended; anything else is the transport
        // failing, which is worth another try.
        if (e.code === 1000) {
          setState('ended');
          return;
        }
        setState('reconnecting');
        retry = setTimeout(connect, RETRY_MS);
      };
    }
    connect();

    // Ctrl-C needs no handling of its own: xterm turns the chord into \x03 and this
    // sends it, which is the byte the tty turns into SIGINT.
    const typed = term.onData((data) => send({ type: 'input', data }));

    // Both observers, because ResizeObserver does not fire when the window changes
    // while the element's own box does not - the tab is the same size either way, and
    // the cell metrics are not. Same pairing as useWidth in chart.mjs.
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(refit);
    if (ro) ro.observe(host);
    const onWindowResize = () => refit();
    window.addEventListener('resize', onWindowResize);

    return () => {
      // Set before the close below, so the handler that runs for it knows this was
      // deliberate and does not schedule a retry against a component that is gone.
      closed = true;
      if (retry) clearTimeout(retry);
      if (ro) ro.disconnect();
      window.removeEventListener('resize', onWindowResize);
      typed.dispose();
      if (ws) ws.close();
      term.dispose();
    };
  }, [taskId, target]);

  const [text, tone] = STATUS[state];

  return html`
    <div class="terminal-frame">
      <div class="terminal-bar">
        <span class="terminal-state ${tone}">${text}</span>
      </div>
      <div class="terminal-host" ref=${hostRef}></div>
    </div>
  `;
}
