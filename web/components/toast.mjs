// Non-blocking notification system. Replaces alert()/prompt() feedback.
// showToast() is a plain function callable from anywhere (not just inside
// components); <ToastContainer/> is mounted once by the app shell and
// subscribes to the shared list.
import { html, useState, useEffect } from '../lib.mjs';

let toasts = [];
let seq = 1;
const listeners = new Set();

function emit() {
  for (const fn of listeners) fn([...toasts]);
}

export function showToast(message, type = 'info') {
  const id = seq++;
  toasts = [...toasts, { id, message: String(message), type }];
  emit();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, 3000);
  return id;
}

export function ToastContainer() {
  const [list, setList] = useState(toasts);
  useEffect(() => {
    listeners.add(setList);
    return () => listeners.delete(setList);
  }, []);

  return html`
    <div class="toast-stack">
      ${list.map(
        (t) => html`
          <div class="toast toast-${t.type}" key=${t.id}>${t.message}</div>
        `
      )}
    </div>
  `;
}
