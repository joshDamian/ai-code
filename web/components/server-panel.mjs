import { html, useState, useEffect } from '../lib.mjs';
import { api } from '../api.mjs';
import { onLocalhost } from '../auth.mjs';

// What the dashboard shows when the server it was loaded from is gone.
//
// This is only reachable because the app shell survives without the server: the
// service worker has it cached, so a tab that was open - or an installed app opened
// after the machine rebooted - renders this rather than a browser error page. It
// replaces the routed view rather than sitting beside it, because every view would
// otherwise render its own failed request.
//
// The Start button exists only where it can work. Starting a process needs something
// on the machine holding the port, which is what the supervisor is; a browser cannot
// spawn anything. So the button appears when a supervisor answered and this page is on
// the server's own loopback - a paired phone is never shown a button whose only
// possible outcome is a 403.
export function ServerPanel({ supervisorUp }) {
  // `down` is the resting state; `starting` is a start that has been asked for and is
  // being waited on; `timeout` is one that was accepted and never arrived.
  const [phase, setPhase] = useState('down');
  const [error, setError] = useState(null);
  const canStart = supervisorUp && onLocalhost();

  // One poll for both cases, so a panel that is waiting on a start and a panel waiting
  // on someone to run `ai-code web` in a terminal behave the same way: a 200 from the
  // server reloads the page, and anything else is another wait.
  //
  // The panel polls itself rather than leaving it to the app, because the app has
  // nothing left to poll with - it is this view that is mounted, and when it unmounts
  // the server is back and there is nothing left to notice.
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const began = Date.now();
    const tick = async () => {
      if (cancelled) return;
      try {
        // Any answer at all is the server: the supervisor's responses never get here,
        // because request() reports them as a connectivity change and throws.
        await api.overview();
        if (!cancelled) location.reload();
        return;
      } catch {
        // Still down. Long enough for a start to fail, or for a person to type the
        // command in another window.
      }
      if (cancelled) return;
      const elapsed = Date.now() - began;
      if (phase === 'starting' && elapsed > 30000) return setPhase('timeout');
      // Fast while a start is in flight - it is usually up in under two seconds - and
      // slow otherwise, where the wait is a person doing something else.
      const wait = phase !== 'starting' ? 5000 : elapsed < 2000 ? 500 : 2000;
      timer = setTimeout(tick, wait);
    };
    timer = setTimeout(tick, phase === 'starting' ? 400 : 5000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phase]);

  async function start() {
    setError(null);
    setPhase('starting');
    try {
      await api.supervisorStart();
    } catch (e) {
      // 409 is another tab having asked first, which this one then waits out like any
      // other start rather than reporting an error nobody caused.
      if (e.status === 409) return;
      setPhase('down');
      setError(e.message);
    }
  }

  // The three resting states, in the order the reader needs them: what happened, what
  // this device can do about it, and what to do if it cannot.
  let action;
  if (phase === 'starting') {
    action = html`<div class="muted">Starting the server…</div>`;
  } else if (phase === 'timeout') {
    action = html`
      <div class="muted">
        The start was accepted but the server has not answered. Its output is in
        <code>~/Library/Logs/ai-code/server.log</code>.
      </div>
    `;
  } else if (canStart) {
    action = html`<button class="btn primary" onClick=${start}>Start server</button>`;
  } else if (supervisorUp) {
    // A supervisor is holding the port, but this page is not on the machine it is
    // holding it on - the phone, which can reach the API and nothing more.
    action = html`<div class="muted">Starting the server needs a terminal on the machine itself.</div>`;
  } else {
    action = html`
      <div class="muted">
        Nothing on this machine is listening for a start request. Run <code>ai-code web</code> in a terminal there,
        or install the supervisor (<code>bin/install-ai-code --supervisor</code>) to put a Start button here.
      </div>
    `;
  }

  return html`
    <div class="server-panel">
      <div class="card server-card">
        <div>
          <div class="logo-title">AI Code</div>
          <div class="logo-sub muted">Mission control</div>
        </div>
        <div class="server-status">
          <span class="status-dot ${phase === 'starting' ? 'warn' : 'bad'}"></span>
          <span>${phase === 'starting' ? 'Starting the server…' : 'The dashboard server is not running'}</span>
        </div>
        <p class="muted">
          The dashboard is a process on the machine it runs on, and it is not answering. Nothing is progressing while
          it is down: no plans, no runs, no terminals.
        </p>
        ${action}
        ${error ? html`<div class="token-error">${error}</div>` : null}
        <p class="muted">Or run <code>ai-code web</code> in a terminal on that machine.</p>
      </div>
    </div>
  `;
}
