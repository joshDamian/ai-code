// The approval card the whole app shows. A conversation's permission prompt stops
// its agent until a person answers, and the conversation's own view was the only
// place it appeared - so a prompt raised while the person was on Tasks counted down
// to a denial unseen. This card shows the oldest waiting prompt on every screen
// except the conversation that already shows it, with the same Allow and Deny.
//
// Polled rather than streamed: one small GET every few seconds while the page is
// visible, and nothing while it is hidden - the push notification covers that case.

import { html, useState, useEffect, useRef, useCallback } from '../lib.mjs';
import { api } from '../api.mjs';
import { showToast } from './toast.mjs';
import { notify } from './notify.mjs';
import { Approval } from '../views/sessions.mjs';

const POLL_MS = 2000;

export function ApprovalDock({ route, navigate, paused }) {
  const [pending, setPending] = useState([]);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  // "Later": the card shrinks to a pill until a prompt arrives that was not
  // waiting when it was put away.
  const [later, setLater] = useState(false);
  // Prompts already announced, so a poll does not chime twice for one prompt. Seeded
  // by the first poll without a chime: a prompt that was waiting before the page
  // opened is shown, not announced.
  const seen = useRef(null);

  const poll = useCallback(async () => {
    try {
      const list = await api.pendingPermissions();
      setPending(list);
      const fresh = seen.current ? list.filter((p) => !seen.current.has(p.id)) : [];
      seen.current = new Set(list.map((p) => p.id));
      if (fresh.length) setLater(false);
      for (const p of fresh) {
        notify('Approval needed', `${p.session_name} wants to run ${p.tool}.`, {
          tag: `permission-${p.id}`,
          onClick: () => navigate(`#/sessions/${p.session_id}`),
        });
      }
    } catch {
      // The next poll tries again; an approval card is not worth an error toast.
    }
  }, [navigate]);

  useEffect(() => {
    if (paused) return undefined;
    let timer = null;
    const tick = () => {
      if (document.visibilityState === 'visible') poll();
    };
    tick();
    timer = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [paused, poll]);

  // The countdown ticks only while there is something to count down.
  useEffect(() => {
    if (!pending.length) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pending.length]);

  // The open conversation draws its own prompt; showing it twice would be two
  // buttons for one decision.
  const here = route.view === 'session-detail' ? route.id : null;
  const shown = pending.filter((p) => p.session_id !== here && Date.parse(p.timeout_at) > now);
  const current = shown[0];

  const answer = useCallback(
    async (action) => {
      if (!current) return;
      setBusy(true);
      try {
        await api.answerSessionPermission(current.session_id, current.id, action);
      } catch (e) {
        // A 409 is the countdown having fired first: already denied.
        showToast(e.message, 'error');
      } finally {
        setPending((list) => list.filter((p) => p.id !== current.id));
        setBusy(false);
        poll();
      }
    },
    [current, poll]
  );

  if (!current) return null;
  const more = shown.length - 1;
  // Inside a conversation the full card would sit on that conversation's own prompt
  // and composer, so it is a pill there, and the pill opens the conversation asking.
  if (here || later) {
    const open = () => (here ? navigate(`#/sessions/${current.session_id}`) : setLater(false));
    return html`
      <button class="approval-pill" type="button" onClick=${open}>
        <span class="approval-dock-dot" aria-hidden="true"></span>
        <span class="approval-dock-name">${current.session_name}</span>
        <span>${more > 0 ? `and ${more} more need approval` : 'needs approval'}</span>
        <span class="approval-pill-go">Review</span>
      </button>
    `;
  }
  return html`
    <div class="approval-dock" role="region" aria-label="Approval needed">
      <div class="approval-dock-from">
        <span class="approval-dock-dot" aria-hidden="true"></span>
        <span class="approval-dock-name">${current.session_name}</span>
        ${current.project_name ? html`<span class="muted"> · ${current.project_name}</span>` : null}
        ${more > 0 ? html`<span class="badge badge-warn">+${more} waiting</span>` : null}
        <a class="approval-dock-open" href=${`#/sessions/${current.session_id}`}>Open conversation</a>
        <button class="btn ghost sm approval-dock-later" type="button" onClick=${() => setLater(true)}>Later</button>
      </div>
      <${Approval} permission=${current} now=${now} busy=${busy} onAnswer=${answer} root=${current.project_path || ''} />
    </div>
  `;
}
