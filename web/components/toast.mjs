// Non-blocking notification system. Replaces alert()/prompt() feedback.
// showToast() is a plain function callable from anywhere (not just inside
// components); <ToastContainer/> is mounted once by the app shell and
// subscribes to the shared list.
//
// Three things a toast has to do to be usable rather than merely visible. It has
// to reach a screen reader, which means living in a live region. It has to be
// dismissible, because an error that covers the thing it is about is in the way.
// And it must not disappear while it is being read, so the timer pauses on hover
// and an error gets a longer window than a confirmation.
import { html, useState, useEffect, useRef } from '../lib.mjs';

// An error says something went wrong and usually says what to do about it, which
// takes longer to read than "Task created.". It also tends to arrive when the
// person is looking somewhere else.
const DURATION = { error: 6000, info: 4000, success: 4000 };

let toasts = [];
let seq = 1;
const listeners = new Set();

function emit() {
  for (const fn of listeners) fn([...toasts]);
}

function remove(id) {
  const next = toasts.filter((t) => t.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

export function showToast(message, type = 'info') {
  const id = seq++;
  toasts = [...toasts, { id, message: String(message), type }];
  emit();
  return id;
}

function Toast({ toast }) {
  const [paused, setPaused] = useState(false);
  const timer = useRef(0);

  useEffect(() => {
    if (paused) return undefined;
    timer.current = setTimeout(() => remove(toast.id), DURATION[toast.type] ?? DURATION.info);
    return () => clearTimeout(timer.current);
  }, [paused, toast.id, toast.type]);

  return html`
    <div
      class="toast toast-${toast.type}"
      role=${toast.type === 'error' ? 'alert' : null}
      onMouseEnter=${() => setPaused(true)}
      onMouseLeave=${() => setPaused(false)}
      onFocus=${() => setPaused(true)}
      onBlur=${() => setPaused(false)}
    >
      <span class="toast-text">${toast.message}</span>
      <button class="toast-close" type="button" aria-label="Dismiss" onClick=${() => remove(toast.id)}>✕</button>
    </div>
  `;
}

export function ToastContainer() {
  const [list, setList] = useState(toasts);
  useEffect(() => {
    listeners.add(setList);
    return () => listeners.delete(setList);
  }, []);

  return html`
    <div class="toast-stack" role="status" aria-live="polite">
      ${list.map((t) => html`<${Toast} toast=${t} key=${t.id} />`)}
    </div>
  `;
}
