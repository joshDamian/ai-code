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
import { terminalUrl } from '../api.mjs';
import { THEME_EVENT } from '../theme.mjs';

// How long to wait before reattaching after an abnormal close - a bounced server, a
// dropped network. A deliberate close is not retried at all: 1000 means the shell
// itself exited, and reconnecting there would spawn a fresh shell every two seconds
// at a command that exits immediately.
const RETRY_MS = 2000;

const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';

// The emulator needs colours as values, not as the custom properties the rest of the
// stylesheet uses, so they are read off the document rather than repeated here. Ansi
// black-through-white are left at xterm's defaults, which are tuned for a dark
// background - which is why a theme's terminal is its code well (--well-bg), dark in
// every theme, and only Classic, which has no well, draws on the page's own colours.
function palette() {
  const read = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  const well = read('--well-bg', '');
  if (well) {
    const ink = read('--well-text', '#e9e9ea');
    return { background: well, foreground: ink, cursor: ink, cursorAccent: well, selectionBackground: 'rgba(255,255,255,.22)' };
  }
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

// `query` names the shell: {task}, {project}, or {session} for `claude --resume`.
export function TerminalPane({ query }) {
  const key = new URLSearchParams(query).toString();
  const [nonce, setNonce] = useState(0);
  const hostRef = useRef(null);
  // The input sender, handed out of the connection effect so the key row below - which
  // is a sibling of the terminal, not part of it - can type into the same socket.
  const sendRef = useRef(/** @type {((m: {type: string, data: string}) => void) | null} */ (null));
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
    sendRef.current = send;

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
      ws = new WebSocket(terminalUrl(query));
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
    // The canvas does not follow the stylesheet, so a theme change is passed on.
    const onTheme = () => (term.options.theme = palette());
    window.addEventListener(THEME_EVENT, onTheme);

    return () => {
      // Set before the close below, so the handler that runs for it knows this was
      // deliberate and does not schedule a retry against a component that is gone.
      closed = true;
      sendRef.current = null;
      if (retry) clearTimeout(retry);
      if (ro) ro.disconnect();
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener(THEME_EVENT, onTheme);
      typed.dispose();
      if (ws) ws.close();
      term.dispose();
    };
  }, [key, nonce]);

  const [text, tone] = STATUS[state];

  // Keys a soft keyboard does not have, and that a shell needs constantly. Sent on
  // pointerdown with the default suppressed, so the terminal keeps focus and the tap
  // types rather than moving the caret to the button. Shown only on a coarse pointer.
  const press = (data) => sendRef.current?.({ type: 'input', data });
  const paste = async (e) => {
    e.preventDefault();
    try {
      const clip = await navigator.clipboard.readText();
      if (clip) press(clip);
    } catch {
      /* the clipboard is not readable here; the keyboard's own paste still works */
    }
  };

  return html`
    <div class="terminal-frame">
      <div class="terminal-bar">
        <span class="terminal-state ${tone}">${text}</span>
        ${state === 'ended' ? html`<button class="btn sm secondary" type="button" onClick=${() => { setState('connecting'); setNonce((n) => n + 1); }}>Start again</button>` : null}
      </div>
      <div class="terminal-box">
        <div class="terminal-host" ref=${hostRef}></div>
      </div>
      <div class="term-keys" role="toolbar" aria-label="Terminal keys">
        ${TERM_KEYS.map(
          (k) => html`<button class="term-key" type="button" key=${k.label} title=${k.title || k.label} onPointerDown=${(e) => { e.preventDefault(); press(k.data); }}>${k.label}</button>`
        )}
        <button class="term-key" type="button" onPointerDown=${paste}>Paste</button>
      </div>
    </div>
  `;
}

// What a phone's keyboard cannot send, in the order a shell wants them. The arrows and
// the control bytes are the point; |, / and ~ are the three characters a chording-free
// keyboard buries.
const TERM_KEYS = [
  { label: 'Esc', data: '\x1b', title: 'Escape' },
  { label: 'Tab', data: '\t' },
  { label: '^C', data: '\x03', title: 'Ctrl-C' },
  { label: '^D', data: '\x04', title: 'Ctrl-D' },
  { label: '↑', data: '\x1b[A' },
  { label: '↓', data: '\x1b[B' },
  { label: '←', data: '\x1b[D' },
  { label: '→', data: '\x1b[C' },
  { label: '|', data: '|' },
  { label: '/', data: '/' },
  { label: '~', data: '~' },
  { label: '-', data: '-' },
];
