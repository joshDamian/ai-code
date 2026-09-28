// A question with two answers, asked before something irreversible happens.
//
// `confirmAction()` returns a promise, so a caller reads as a straight line:
//
//     if (!(await confirmAction({ title: 'Close this task?', ... }))) return;
//
// The alternative the dashboard had was a button that ran its handler on the
// first click. Close discards the task's worktree, and there is no undo for that
// - so the click has to be a question rather than a decision.
//
// Mounted once by the app shell, the way ToastContainer is, because a dialog
// that only one view can raise is a dialog the next view has to build again.
import { html, useState, useEffect, useRef } from '../lib.mjs';

let pending = null;
let seq = 1;
const listeners = new Set();

function emit() {
  for (const fn of listeners) fn(pending);
}

// Resolves true when the action was confirmed and false for every other exit -
// Cancel, Escape, a click on the scrim. A caller only has to test the truth, and
// the failure to answer is the safe answer by construction.
export function confirmAction({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'default' }) {
  return new Promise((resolve) => {
    pending = { id: seq++, title, body, confirmLabel, cancelLabel, tone, resolve };
    emit();
  });
}

export function ConfirmHost() {
  const [req, setReq] = useState(pending);
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);

  useEffect(() => {
    listeners.add(setReq);
    return () => listeners.delete(setReq);
  }, []);

  useEffect(() => {
    if (!req) return undefined;
    // Focus lands on Cancel rather than on the confirm button. The dialog is a
    // guard, and a keyboard user who opened it and pressed Enter without reading
    // it should decline the action, not take it.
    cancelRef.current?.focus();

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        // The page's own Escape handlers - clearing a search field, closing the
        // palette - must not also fire, or one Escape would close the dialog and
        // the thing under it. Captured on `document`, which runs before the
        // window listener those handlers are bound to.
        e.stopPropagation();
        settle(false);
        return;
      }
      if (e.key !== 'Tab') return;
      // A focus trap, because the page behind the scrim is still tabbable and a
      // modal that lets focus walk out of it is not modal.
      const nodes = dialogRef.current?.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [req]);

  function settle(value) {
    const asked = req;
    if (!asked) return;
    if (pending && pending.id === asked.id) {
      pending = null;
      emit();
    }
    asked.resolve(value);
  }

  if (!req) return null;

  return html`
    <div
      class="kbd-overlay confirm-overlay"
      onClick=${(e) => {
        if (e.target === e.currentTarget) settle(false);
      }}
    >
      <div
        class="card dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby=${req.body ? 'confirm-body' : null}
        ref=${dialogRef}
      >
        <h2 class="dialog-title" id="confirm-title">${req.title}</h2>
        ${req.body ? html`<p class="dialog-body" id="confirm-body">${req.body}</p>` : null}
        <div class="dialog-actions">
          <button class="btn secondary" type="button" ref=${cancelRef} onClick=${() => settle(false)}>${req.cancelLabel}</button>
          <button
            class="btn ${req.tone === 'danger' ? 'danger' : 'primary'}"
            type="button"
            onClick=${() => settle(true)}
          >
            ${req.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  `;
}
